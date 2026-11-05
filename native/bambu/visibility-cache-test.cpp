#include "SeamVisibilityReuse.hpp"
#include <array>
#include <cassert>
#include <cmath>
#include <limits>
#include <memory>
#include <stdexcept>
#include <vector>

using namespace Slic3r::SeamPlacerImpl;

struct Matrix {
    std::array<double, 16> values{};
    bool allFinite() const {
        for (double value : values) if (!std::isfinite(value)) return false;
        return true;
    }
    bool operator==(const Matrix &other) const { return values == other.values; }
};
struct Transform { Matrix value; const Matrix &matrix() const { return value; } };
struct Object {
    const Object *shared = nullptr;
    Transform centered;
    const Object *get_shared_object() const { return shared; }
    Transform trafo_centered() const { return centered; }
};
struct Samples {
    static int alive;
    std::vector<int> positions{1, 2, 3};
    const std::vector<int> *tree_positions = &positions;
    Samples() { ++alive; }
    ~Samples() { --alive; }
    Samples(const Samples &) = delete;
    Samples(Samples &&) = delete;
};
int Samples::alive = 0;

int main()
{
    Object source, linked, independent;
    linked.shared = &source;
    assert(seam_visibility_reuse_source(&source) == &source);
    assert(seam_visibility_reuse_source(&linked) == &source);
    assert(seam_visibility_reuse_source(&independent) == &independent);
    for (int component = 0; component < 16; ++component) {
        linked.centered.value.values[component] = 0.000000001;
        assert(seam_visibility_reuse_source(&linked) == &linked);
        linked.centered.value.values[component] = 0;
    }
    linked.centered.value.values[0] = std::numeric_limits<double>::quiet_NaN();
    assert(seam_visibility_reuse_source(&linked) == &linked);
    linked.centered.value.values[0] = std::numeric_limits<double>::infinity();
    assert(seam_visibility_reuse_source(&linked) == &linked);
    linked.centered.value.values[0] = 0;
    source.centered.value.values[0] = std::numeric_limits<double>::infinity();
    assert(seam_visibility_reuse_source(&linked) == &linked);
    source.centered.value.values[0] = 0;

    int computations = 0;
    auto build = [&] { assert(Samples::alive == 0); ++computations; return std::make_unique<Samples>(); };
    {
        SeamVisibilityReuseCache<const Object *, Samples> cache;
        const Samples *first = nullptr;
        for (int instance = 0; instance < 10; ++instance) {
            const Samples &data = cache.get_or_create(&source, build);
            assert(data.tree_positions == &data.positions);
            if (instance == 0) first = &data;
            else assert(&data == first);
        }
        assert(computations == 1 && Samples::alive == 1);
        cache.get_or_create(&independent, build);
        assert(!cache.matches(&source) && cache.matches(&independent));
        cache.get_or_create(&source, build);
        assert(computations == 3 && Samples::alive == 1);
        try {
            cache.get_or_create(&independent, []() -> std::unique_ptr<Samples> { throw std::runtime_error("cancelled"); });
            assert(false);
        } catch (const std::runtime_error &) {}
        assert(!cache.matches(&source) && !cache.matches(&independent) && Samples::alive == 0);
        try {
            cache.get_or_create(&source, [] { return std::unique_ptr<Samples>(); });
            assert(false);
        } catch (const std::logic_error &) {}
        assert(!cache.matches(&source) && Samples::alive == 0);
        cache.get_or_create(&source, build);
        cache.clear();
        assert(Samples::alive == 0 && !cache.matches(&source));
        cache.get_or_create(&source, build);
    }
    assert(Samples::alive == 0);
    {
        SeamVisibilityReuseCache<const Object *, Samples> fresh_slice;
        fresh_slice.get_or_create(&source, build);
    }
    assert(computations == 6 && Samples::alive == 0);
}
