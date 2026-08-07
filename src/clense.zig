const std = @import("std");
const vapoursynth = @import("vapoursynth");
const ZAPI = vapoursynth.ZAPI;
const testing = @import("std").testing;
const testingAllocator = @import("std").testing.allocator;

const copy = @import("common/copy.zig");
const types = @import("common/type.zig");
const vscmn = @import("common/vapoursynth.zig");
const sort = @import("common/sorting_networks.zig");
const math = @import("common/math.zig");
const vec = @import("common/vector.zig");
const f16cmn = @import("common/f16.zig");
const float_mode: std.builtin.FloatMode = if (@import("config").optimize_float) .optimized else .strict;

const vs = vapoursynth.vapoursynth4;
const vsh = vapoursynth.vshelper;

const ar = vs.ActivationReason;
const rp = vs.RequestPattern;
const fm = vs.FilterMode;
const st = vs.SampleType;

const allocator = std.heap.c_allocator;

const ClenseMode = enum {
    Normal,
    Forward,
    Backward,
};

const ClenseData = struct {
    // The clip on which we are operating.
    cnode: ?*vs.Node,
    pnode: ?*vs.Node,
    nnode: ?*vs.Node,

    vi: *const vs.VideoInfo,

    // The modes for each plane we will process.
    process: [3]bool,

    mode: ClenseMode,
};

fn Clense(comptime T: type) type {
    return struct {
        const SAT = types.SignedArithmeticType(T);
        const UAT = types.UnsignedArithmeticType(T);

        /// Scalar reference used for tails and differential tests.
        fn clenseScalar(noalias dstp: []T, noalias srcp: []const T, noalias prev: []const T, noalias next: []const T, width: usize, height: usize, stride: usize) void {
            @setFloatMode(float_mode);

            for (0..height) |row| {
                for (0..width) |column| {
                    const p = prev[(row * stride) + column];
                    const c = srcp[(row * stride) + column];
                    const n = next[(row * stride) + column];

                    dstp[(row * stride) + column] = sort.median3(p, c, n);
                }
            }
        }

        /// Find the median of the previous, current, and next frames using
        /// explicit vectors. This avoids relying on LLVM loop vectorisation.
        fn clense(noalias dstp: []T, noalias srcp: []const T, noalias prev: []const T, noalias next: []const T, width: usize, height: usize, stride: usize) void {
            @setFloatMode(float_mode);

            if (comptime T == f16) {
                return switch (@import("config").f16_simd) {
                    .scalar => clenseScalar(dstp, srcp, prev, next, width, height, stride),
                    .native => clenseF16Native(dstp, srcp, prev, next, width, height, stride),
                    .widened => clenseF16(dstp, srcp, prev, next, width, height, stride),
                    .auto => if (f16cmn.target_has_native_fp16_arithmetic)
                        clenseF16Native(dstp, srcp, prev, next, width, height, stride)
                    else
                        clenseF16(dstp, srcp, prev, next, width, height, stride),
                };
            }

            const V = @Vector(vec.getVecSize(T), T);
            const vector_len = @typeInfo(V).vector.len;

            for (0..height) |row| {
                const row_start = row * stride;
                var column: usize = 0;
                while (column + vector_len <= width) : (column += vector_len) {
                    const offset = row_start + column;
                    const p = vec.load(V, prev, offset);
                    const c = vec.load(V, srcp, offset);
                    const n = vec.load(V, next, offset);
                    vec.store(V, dstp, offset, sort.median3(p, c, n));
                }

                for (column..width) |tail_column| {
                    const offset = row_start + tail_column;
                    dstp[offset] = sort.median3(prev[offset], srcp[offset], next[offset]);
                }
            }
        }

        fn clenseF16(noalias dstp: []f16, noalias srcp: []const f16, noalias prev: []const f16, noalias next: []const f16, width: usize, height: usize, stride: usize) void {
            const V16 = @Vector(vec.getVecSize(f32), f16);
            const V32 = @Vector(@typeInfo(V16).vector.len, f32);
            const vector_len = @typeInfo(V16).vector.len;

            for (0..height) |row| {
                const row_start = row * stride;
                var column: usize = 0;
                while (column + vector_len <= width) : (column += vector_len) {
                    const offset = row_start + column;
                    const p: V32 = vec.loadF16AsF32(V16, V32, prev, offset);
                    const c: V32 = vec.loadF16AsF32(V16, V32, srcp, offset);
                    const n: V32 = vec.loadF16AsF32(V16, V32, next, offset);
                    vec.storeF32AsF16(V16, dstp, offset, sort.median3(p, c, n));
                }

                for (column..width) |tail_column| {
                    const offset = row_start + tail_column;
                    dstp[offset] = sort.median3(prev[offset], srcp[offset], next[offset]);
                }
            }
        }

        fn clenseF16Native(noalias dstp: []f16, noalias srcp: []const f16, noalias prev: []const f16, noalias next: []const f16, width: usize, height: usize, stride: usize) void {
            const V = @Vector(vec.getVecSize(f16), f16);
            const vector_len = @typeInfo(V).vector.len;

            for (0..height) |row| {
                const row_start = row * stride;
                var column: usize = 0;
                while (column + vector_len <= width) : (column += vector_len) {
                    const offset = row_start + column;
                    const p = vec.load(V, prev, offset);
                    const c = vec.load(V, srcp, offset);
                    const n = vec.load(V, next, offset);
                    vec.store(V, dstp, offset, sort.median3(p, c, n));
                }

                for (column..width) |tail_column| {
                    const offset = row_start + tail_column;
                    dstp[offset] = sort.median3(prev[offset], srcp[offset], next[offset]);
                }
            }
        }

        /// Clamps the source pixel using the difference between the furthest frame and the weighted minimum or maximum pixel of the closest and furthest frames.
        fn clenseForwardBackwardScalar(noalias dstp: []T, noalias srcp: []const T, noalias ref1p: []const T, noalias ref2p: []const T, width: usize, height: usize, stride: usize) void {
            @setFloatMode(float_mode);

            for (0..height) |row| {
                for (0..width) |column| {
                    const ref1 = ref1p[(row * stride) + column];
                    const ref2 = ref2p[(row * stride) + column];
                    const src = srcp[(row * stride) + column];

                    // Find the brightest and darket pixels
                    const minref = @min(ref1, ref2);
                    const maxref = @max(ref1, ref2);

                    // Use saturating arithmetic to prevent needing to use a higher
                    // integer bit depth.
                    const lowref = if (types.isInt(T))
                        minref -| (ref2 -| minref)
                    else
                        minref * 2 - ref2;

                    const highref = if (types.isInt(T))
                        (maxref -| ref2) +| maxref
                    else
                        maxref * 2 - ref2;

                    dstp[(row * stride) + column] = std.math.clamp(src, lowref, highref);
                }
            }
        }

        fn clenseForwardBackward(noalias dstp: []T, noalias srcp: []const T, noalias ref1p: []const T, noalias ref2p: []const T, width: usize, height: usize, stride: usize) void {
            @setFloatMode(float_mode);

            if (comptime T == f16) {
                return clenseForwardBackwardF16(dstp, srcp, ref1p, ref2p, width, height, stride);
            }

            const V = @Vector(vec.getVecSize(T), T);
            const vector_len = @typeInfo(V).vector.len;

            for (0..height) |row| {
                const row_start = row * stride;
                var column: usize = 0;
                while (column + vector_len <= width) : (column += vector_len) {
                    const offset = row_start + column;
                    const ref1 = vec.load(V, ref1p, offset);
                    const ref2 = vec.load(V, ref2p, offset);
                    const src = vec.load(V, srcp, offset);
                    const minref = @min(ref1, ref2);
                    const maxref = @max(ref1, ref2);
                    const two: V = @splat(2);
                    const lowref = if (comptime types.isInt(T)) minref -| (ref2 -| minref) else minref * two - ref2;
                    const highref = if (comptime types.isInt(T)) (maxref -| ref2) +| maxref else maxref * two - ref2;
                    vec.store(V, dstp, offset, std.math.clamp(src, lowref, highref));
                }

                for (column..width) |tail_column| {
                    const offset = row_start + tail_column;
                    const ref1 = ref1p[offset];
                    const ref2 = ref2p[offset];
                    const src = srcp[offset];
                    const minref = @min(ref1, ref2);
                    const maxref = @max(ref1, ref2);
                    const lowref = if (comptime types.isInt(T)) minref -| (ref2 -| minref) else minref * 2 - ref2;
                    const highref = if (comptime types.isInt(T)) (maxref -| ref2) +| maxref else maxref * 2 - ref2;
                    dstp[offset] = std.math.clamp(src, lowref, highref);
                }
            }
        }

        fn clenseForwardBackwardF16(noalias dstp: []f16, noalias srcp: []const f16, noalias ref1p: []const f16, noalias ref2p: []const f16, width: usize, height: usize, stride: usize) void {
            const V16 = @Vector(vec.getVecSize(f32), f16);
            const V32 = @Vector(@typeInfo(V16).vector.len, f32);
            const vector_len = @typeInfo(V16).vector.len;

            for (0..height) |row| {
                const row_start = row * stride;
                var column: usize = 0;
                while (column + vector_len <= width) : (column += vector_len) {
                    const offset = row_start + column;
                    const ref1: V32 = vec.loadF16AsF32(V16, V32, ref1p, offset);
                    const ref2: V32 = vec.loadF16AsF32(V16, V32, ref2p, offset);
                    const src: V32 = vec.loadF16AsF32(V16, V32, srcp, offset);
                    const minref = @min(ref1, ref2);
                    const maxref = @max(ref1, ref2);
                    const two: V32 = @splat(2.0);
                    const lowref = minref * two - ref2;
                    const highref = maxref * two - ref2;
                    vec.storeF32AsF16(V16, dstp, offset, std.math.clamp(src, lowref, highref));
                }

                for (column..width) |tail_column| {
                    const offset = row_start + tail_column;
                    const ref1: f32 = @floatCast(ref1p[offset]);
                    const ref2: f32 = @floatCast(ref2p[offset]);
                    const src: f32 = @floatCast(srcp[offset]);
                    const minref = @min(ref1, ref2);
                    const maxref = @max(ref1, ref2);
                    dstp[offset] = @floatCast(std.math.clamp(src, minref * 2 - ref2, maxref * 2 - ref2));
                }
            }
        }

        test clense {
            const width = vec.getVecSize(T) + 3;
            const height = 5;
            const stride = width;
            const prev = [_]T{3} ** (height * stride);
            const srcp = [_]T{1} ** (height * stride);
            const next = [_]T{5} ** (height * stride);

            const dstp = try testingAllocator.alloc(T, height * stride);
            defer testingAllocator.free(dstp);

            clense(dstp, &srcp, &prev, &next, width, height, stride);

            const expected = [_]T{3} ** (height * stride);
            try std.testing.expectEqualDeep(&expected, dstp);
        }

        test "F16 native clense matches scalar with strided tail" {
            if (comptime T != f16) return;

            const width = vec.getVecSize(f16) + 3;
            const height = 3;
            const stride = width + 2;
            const size = height * stride;
            const values = [_]f16{ 0, 0.25, 0.5, 0.75, 1, 1.5, 2, 3 };

            const prev = try testingAllocator.alloc(f16, size);
            defer testingAllocator.free(prev);
            const srcp = try testingAllocator.alloc(f16, size);
            defer testingAllocator.free(srcp);
            const next = try testingAllocator.alloc(f16, size);
            defer testingAllocator.free(next);
            const scalar = try testingAllocator.alloc(f16, size);
            defer testingAllocator.free(scalar);
            const native = try testingAllocator.alloc(f16, size);
            defer testingAllocator.free(native);

            for (0..size) |i| {
                prev[i] = values[(i * 3 + 1) % values.len];
                srcp[i] = values[(i * 5 + 2) % values.len];
                next[i] = values[(i * 7 + 3) % values.len];
            }
            @memset(scalar, 0);
            @memset(native, 0);

            clenseScalar(scalar, srcp, prev, next, width, height, stride);
            clenseF16Native(native, srcp, prev, next, width, height, stride);

            for (0..height) |row| {
                const row_start = row * stride;
                try testing.expectEqualSlices(
                    f16,
                    scalar[row_start .. row_start + width],
                    native[row_start .. row_start + width],
                );
            }
        }

        test clenseForwardBackward {
            const width = vec.getVecSize(T) + 3;
            const height = 5;
            const stride = width;
            const ref1 = [_]T{7} ** (height * stride);
            const srcp = [_]T{1} ** (height * stride);
            const ref2 = [_]T{5} ** (height * stride);

            const dstp = try testingAllocator.alloc(T, height * stride);
            defer testingAllocator.free(dstp);

            clenseForwardBackward(dstp, &srcp, &ref1, &ref2, width, height, stride);

            const expected = [_]T{5} ** (height * stride);
            try std.testing.expectEqualDeep(&expected, dstp);
        }

        fn processPlane(mode: ClenseMode, noalias dstp8: []u8, noalias srcp8: []const u8, noalias ref1p8: []const u8, noalias ref2p8: []const u8, width: usize, height: usize, stride8: usize) void {
            const stride = stride8 / @sizeOf(T);
            const srcp: []const T = @ptrCast(@alignCast(srcp8));
            const ref1p: []const T = @ptrCast(@alignCast(ref1p8));
            const ref2p: []const T = @ptrCast(@alignCast(ref2p8));
            const dstp: []T = @ptrCast(@alignCast(dstp8));

            switch (mode) {
                .Normal => clense(dstp, srcp, ref1p, ref2p, width, height, stride),
                .Forward => clenseForwardBackward(dstp, srcp, ref1p, ref2p, width, height, stride),
                .Backward => clenseForwardBackward(dstp, srcp, ref1p, ref2p, width, height, stride),
            }
        }
    };
}

fn clenseGetFrame(n: c_int, activation_reason: ar, instance_data: ?*anyopaque, frame_data: ?*?*anyopaque, frame_ctx: ?*vs.FrameContext, core: ?*vs.Core, vsapi: ?*const vs.API) callconv(.c) ?*const vs.Frame {
    const zapi = ZAPI.init(vsapi, core, frame_ctx);
    const d: *ClenseData = @ptrCast(@alignCast(instance_data));

    if (activation_reason == ar.Initial) {
        switch (d.mode) {
            .Normal => {
                if (n >= 1 and n <= d.vi.numFrames - 2) {
                    frame_data.?.* = @ptrCast(@as(*void, @ptrFromInt(1)));
                    zapi.requestFrameFilter(n - 1, d.pnode);
                    zapi.requestFrameFilter(n, d.cnode);
                    zapi.requestFrameFilter(n + 1, d.nnode);
                } else {
                    zapi.requestFrameFilter(n, d.cnode);
                }
            },
            .Forward => {
                zapi.requestFrameFilter(n, d.cnode);
                if (n <= d.vi.numFrames - 3) {
                    frame_data.?.* = @ptrCast(@as(*void, @ptrFromInt(1)));
                    zapi.requestFrameFilter(n + 1, d.cnode);
                    zapi.requestFrameFilter(n + 2, d.cnode);
                }
            },
            .Backward => {
                if (n >= 2) {
                    frame_data.?.* = @ptrCast(@as(*void, @ptrFromInt(1)));
                    zapi.requestFrameFilter(n - 2, d.cnode);
                    zapi.requestFrameFilter(n - 1, d.cnode);
                }
                zapi.requestFrameFilter(n, d.cnode);
            },
        }
    } else if (activation_reason == ar.AllFramesReady) {
        // Skip processing on first/last frames.
        // Uses `framedata` to communicate state between getFrame calls, as the first call is for ar.Initial to request necessary frames, and the second call is for ar.AllFramesReady once said requested frames are available.
        // Nifty trick, taken from RGVS/SF + Vapoursynth's SelectEvery function.
        if (@intFromPtr(frame_data.?.*) != 1) {
            return zapi.getFrameFilter(n, d.cnode);
        }

        const ref1 = switch (d.mode) {
            .Normal => zapi.initZFrame(d.pnode, n - 1),
            .Forward => zapi.initZFrame(d.cnode, n + 1),
            .Backward => zapi.initZFrame(d.cnode, n - 1),
        };
        const src_frame = zapi.initZFrame(d.cnode, n);
        const ref2 = switch (d.mode) {
            .Normal => zapi.initZFrame(d.nnode, n + 1),
            .Forward => zapi.initZFrame(d.cnode, n + 2),
            .Backward => zapi.initZFrame(d.cnode, n - 2),
        };

        defer {
            ref1.deinit();
            src_frame.deinit();
            ref2.deinit();
        }

        const dst = src_frame.newVideoFrame2(d.process);

        const processPlane = switch (vscmn.FormatType.getDataType(d.vi.format)) {
            .U8 => &Clense(u8).processPlane,
            .U16 => &Clense(u16).processPlane,
            .F16 => &Clense(f16).processPlane,
            .F32 => &Clense(f32).processPlane,
        };

        for (0..@intCast(d.vi.format.numPlanes)) |plane| {
            // Skip planes we aren't supposed to process
            if (!d.process[plane]) {
                continue;
            }

            const width: usize = dst.getWidth(plane);
            const height: usize = dst.getHeight(plane);
            const stride8: usize = dst.getStride(plane);
            const ref1p8: []const u8 = ref1.getReadSlice(plane);
            const srcp8: []const u8 = src_frame.getReadSlice(plane);
            const ref2p8: []const u8 = ref2.getReadSlice(plane);
            const dstp8: []u8 = dst.getWriteSlice(plane);

            processPlane(d.mode, dstp8, srcp8, ref1p8, ref2p8, width, height, stride8);
        }

        return dst.frame;
    }

    return null;
}

export fn clenseFree(instance_data: ?*anyopaque, core: ?*vs.Core, vsapi: ?*const vs.API) callconv(.c) void {
    _ = core;
    const d: *ClenseData = @ptrCast(@alignCast(instance_data));
    vsapi.?.freeNode.?(d.cnode);
    vsapi.?.freeNode.?(d.pnode);
    vsapi.?.freeNode.?(d.nnode);
    allocator.destroy(d);
}

export fn clenseCreate(in: ?*const vs.Map, out: ?*vs.Map, user_data: ?*anyopaque, core: ?*vs.Core, vsapi: ?*const vs.API) callconv(.c) void {
    const zapi = ZAPI.init(vsapi, core, null);
    const inz = zapi.initZMap(in);
    const outz = zapi.initZMap(out);

    var d: ClenseData = undefined;

    d.cnode, d.vi = inz.getNodeVi("clip").?;
    d.pnode = null;
    d.nnode = null;

    d.mode = @as(*ClenseMode, @ptrCast(user_data)).*;

    if (!vsh.isConstantVideoFormat(d.vi)) {
        outz.setError("Clense: only constant format input supported");
        zapi.freeNode(d.cnode);
        return;
    }

    if (d.mode == .Normal) {
        // Reference previous/next clips, falling back to the main clip
        // if either are absent.
        d.pnode = inz.getNode("previous") orelse zapi.addNodeRef(d.cnode);
        d.nnode = inz.getNode("next") orelse zapi.addNodeRef(d.cnode);

        if (d.pnode != null and !vsh.isSameVideoInfo(d.vi, zapi.getVideoInfo(d.pnode))) {
            outz.setError("Clense: previous clip does not have the same format as the main clip.");
            zapi.freeNode(d.cnode);
            zapi.freeNode(d.pnode);
            zapi.freeNode(d.nnode);
        }

        if (d.nnode != null and !vsh.isSameVideoInfo(d.vi, zapi.getVideoInfo(d.nnode))) {
            outz.setError("Clense: next clip does not have the same format as the main clip.");
            zapi.freeNode(d.cnode);
            zapi.freeNode(d.pnode);
            zapi.freeNode(d.nnode);
        }
    }

    d.process = vscmn.normalizePlanes(d.vi.format, in, vsapi) catch |e| {
        zapi.freeNode(d.cnode);
        zapi.freeNode(d.pnode);
        zapi.freeNode(d.nnode);

        switch (e) {
            vscmn.PlanesError.IndexOutOfRange => outz.setError("Clense: Plane index out of range."),
            vscmn.PlanesError.SpecifiedTwice => outz.setError("Clense: Plane specified twice."),
        }
        return;
    };

    const data: *ClenseData = allocator.create(ClenseData) catch unreachable;
    data.* = d;

    const normalDeps = [_]vs.FilterDependency{
        vs.FilterDependency{
            .source = d.pnode,
            .requestPattern = rp.NoFrameReuse, // Only a single frame (N - 1) is ever requested from this clip when processing frame N
        },
        vs.FilterDependency{
            .source = d.cnode,
            .requestPattern = rp.StrictSpatial,
        },
        vs.FilterDependency{
            .source = d.nnode,
            .requestPattern = rp.NoFrameReuse, // Only a single frame (N + 1) is ever requested from this clip when processing frame N
        },
    };

    const forwardBackwardDeps = [_]vs.FilterDependency{
        vs.FilterDependency{
            .source = d.cnode,
            .requestPattern = rp.StrictSpatial,
        },
    };

    zapi.createVideoFilter(out, "Clense", d.vi, clenseGetFrame, clenseFree, fm.Parallel, if (d.mode == .Normal) &normalDeps else &forwardBackwardDeps, data);
}

pub fn registerFunction(plugin: *vs.Plugin, vsapi: *const vs.PLUGINAPI) void {
    _ = vsapi.registerFunction.?("Clense", "clip:vnode;previous:vnode:opt;next:vnode:opt;planes:int[]:opt", "clip:vnode;", clenseCreate, @ptrCast(@constCast(&ClenseMode.Normal)), plugin);
    _ = vsapi.registerFunction.?("ForwardClense", "clip:vnode;planes:int[]:opt", "clip:vnode;", clenseCreate, @ptrCast(@constCast(&ClenseMode.Forward)), plugin);
    _ = vsapi.registerFunction.?("BackwardClense", "clip:vnode;planes:int[]:opt", "clip:vnode;", clenseCreate, @ptrCast(@constCast(&ClenseMode.Backward)), plugin);
}
