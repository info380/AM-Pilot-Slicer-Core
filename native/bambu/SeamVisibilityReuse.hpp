#ifndef libslic3r_SeamVisibilityReuse_hpp_
#define libslic3r_SeamVisibilityReuse_hpp_

#include <cstddef>
#include <memory>
#include <optional>
#include <stdexcept>
#include <utility>

namespace Slic3r { namespace SeamPlacerImpl {

// The native shared-object relation is required; geometrically similar but
// independently imported objects never become equivalent through this helper.
// Center offsets are checked separately because occlusion uses trafo_centered().
// Native volume transformation equality is approximate; visibility reuse also
// requires exact finite volume matrices before reusing any sampled geometry.
template<class Object> const Object *seam_visibility_reuse_source(const Object *object)
{
    const Object *source = object->get_shared_object();
    if (source != nullptr) {
        const auto current = object->trafo_centered().matrix();
        const auto reference = source->trafo_centered().matrix();
        if (!current.allFinite() || !reference.allFinite() || !(current == reference))
            return object;
        const auto &volumes = object->model_object()->volumes;
        const auto &source_volumes = source->model_object()->volumes;
        if (volumes.size() != source_volumes.size())
            return object;
        for (std::size_t index = 0; index < volumes.size(); ++index) {
            const auto volume = volumes[index]->get_matrix().matrix();
            const auto source_volume = source_volumes[index]->get_matrix().matrix();
            if (!volume.allFinite() || !source_volume.allFinite() || !(volume == source_volume))
                return object;
        }
        return source;
    }
    return object;
}

// One stable heap allocation at most. Data may contain self-referential tree
// functors, so neither Data nor its sample vectors are copied or moved. The cache
// is local to SeamPlacer::init and cannot retain geometry between slices.
template<class Key, class Data> class SeamVisibilityReuseCache
{
public:
    bool matches(const Key &key) const { return m_data && m_key && *m_key == key; }

    void clear()
    {
        m_data.reset();
        m_key.reset();
    }

    template<class Factory> const Data &get_or_create(const Key &key, Factory &&factory)
    {
        if (!matches(key)) {
            clear();
            // Publish only a complete result; cancellation or a failed factory
            // leaves the cache empty and propagates to the existing caller.
            auto data = std::forward<Factory>(factory)();
            if (!data)
                throw std::logic_error("Seam visibility factory returned no result");
            m_key = key;
            m_data = std::move(data);
        }
        return *m_data;
    }

private:
    std::optional<Key> m_key;
    std::unique_ptr<Data> m_data;
};

}} // namespace Slic3r::SeamPlacerImpl

#endif
