// Internal phase names and durations only. Profiles never enter output artifacts
// or the worker protocol, and must not receive paths, commands or credentials.
export const profileExecutionPhase = async (profile, phase, operation) => {
  if (!profile) return await operation();
  const started = performance.now();
  try {
    const result = await operation();
    profile.completedPhases.push(phase);
    return result;
  } catch (error) {
    profile.failedPhase = phase;
    throw error;
  } finally {
    profile.timingsMs[phase] = Number((performance.now() - started).toFixed(3));
  }
};

export const createExecutionProfile = () => ({ timingsMs: {}, completedPhases: [] });
