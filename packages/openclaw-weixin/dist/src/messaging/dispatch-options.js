/**
 * Bind a channel turn to the Gateway's committed model-runtime owner.
 *
 * OpenClaw 2026.9.x rejects the legacy low-level dispatch path when the
 * caller's config object is not the exact published model-runtime owner.
 */
export function withPublishedModelRuntime(params) {
    return {
        ...params,
        usePublishedModelRuntime: true,
    };
}
//# sourceMappingURL=dispatch-options.js.map