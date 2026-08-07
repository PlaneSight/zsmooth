const std = @import("std");
const builtin = @import("builtin");

/// Whether the compilation target exposes native AArch64 FP16 data-processing
/// instructions. This is a compile-time capability check, never a hot-path
/// runtime probe.
pub const target_has_native_fp16_arithmetic = switch (builtin.target.cpu.arch) {
    .aarch64 => std.Target.aarch64.featureSetHas(builtin.target.cpu.features, .fullfp16),
    else => false,
};
