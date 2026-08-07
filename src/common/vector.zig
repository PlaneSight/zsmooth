/// Common module for operations on vectors.
const std = @import("std");
const assert = std.debug.assert;

/// Loads a vector of type VT from the specific offset memory address.
pub fn load(comptime VT: type, src: []const @typeInfo(VT).vector.child, offset: usize) VT {
    return src[offset..][0..@typeInfo(VT).vector.len].*;
}

/// Loads a vector of type VT from the specific row and column in src.
pub fn loadAt(comptime VT: type, src: []const @typeInfo(VT).vector.child, row: usize, column: usize, stride: usize) VT {
    const offset = row * stride + column;
    return load(VT, src, offset);
}

/// Stores vector data into memory at a given offset.
pub fn store(comptime VT: type, _dst: []@typeInfo(VT).vector.child, offset: usize, result: VT) void {
    _dst[offset..][0..@typeInfo(VT).vector.len].* = result;
}

/// Loads a half-precision vector and widens it exactly once for kernels whose
/// target lacks efficient native FP16 arithmetic.
pub fn loadF16AsF32(comptime VT16: type, comptime VT32: type, src: []const f16, offset: usize) VT32 {
    return @floatCast(load(VT16, src, offset));
}

/// Narrows a vector after an FP32 compute kernel has completed.
pub fn storeF32AsF16(comptime VT16: type, dst: []f16, offset: usize, result: anytype) void {
    store(VT16, dst, offset, @floatCast(result));
}

test "FP16 widening helpers" {
    const V16 = @Vector(4, f16);
    const V32 = @Vector(4, f32);
    const input = [_]f16{ 0.25, 0.5, 0.75, 1.0 };
    var output = [_]f16{ 0, 0, 0, 0 };

    const widened: V32 = loadF16AsF32(V16, V32, &input, 0);
    try std.testing.expectEqual(@as(V32, .{ 0.25, 0.5, 0.75, 1.0 }), widened);

    storeF32AsF16(V16, &output, 0, widened * @as(V32, @splat(2)));
    try std.testing.expectEqualDeep(&[_]f16{ 0.5, 1.0, 1.5, 2.0 }, &output);
}

/// Stores a vector of type VT into dst starting at the given row and column.
pub fn storeAt(comptime VT: type, dst: []@typeInfo(VT).vector.child, row: usize, column: usize, stride: usize, result: VT) void {
    const offset = row * stride + column;
    return store(VT, dst, offset, result);
}

// Inspired by https://github.com/zig-gamedev/zig-gamedev/blob/main/libs/zmath/src/zmath.zig#L744
pub fn minFast(v0: anytype, v1: anytype) @TypeOf(v0, v1) {
    // Use a fast vector trick for floating point vectors,
    // otherwise use the builtin @min
    if (@typeInfo(@TypeOf(v0)) == .vector and (@typeInfo(@TypeOf(v0)).vector.child == f32 or @typeInfo(@TypeOf(v0)).vector.child == f16)) {
        return @select(@typeInfo(@TypeOf(v0)).vector.child, v0 < v1, v0, v1);
    }
    return @min(v0, v1);
}

pub fn maxFast(v0: anytype, v1: anytype) @TypeOf(v0, v1) {
    // Use a fast vector trick for floating point vectors,
    // otherwise use the builtin @max
    if (@typeInfo(@TypeOf(v0)) == .vector and (@typeInfo(@TypeOf(v0)).vector.child == f32 or @typeInfo(@TypeOf(v0)).vector.child == f16)) {
        return @select(@typeInfo(@TypeOf(v0)).vector.child, v0 > v1, v0, v1);
    }
    return @max(v0, v1);
}

pub fn clampFast(v: anytype, vmin: anytype, vmax: anytype) @TypeOf(v, vmin, vmax) {
    return minFast(vmax, maxFast(vmin, v));
}

/// Gets a pertinent vector size for the given type based on the compilation target.
// TODO: Rename to getVectorLength, and rename all vec_size variables to vector_len
pub inline fn getVecSize(comptime T: type) comptime_int {
    if (std.simd.suggestVectorLength(T)) |suggested| {
        return suggested;
    }

    @compileError("The compilation target does not support vector sizing");
}

/// Index a slice using a vector containing indexes.
/// Stolen fair and square from:
/// https://github.com/ziglang/zig/issues/12815
///
//TODO: Switch to official "gather" implementation whenever the above link is resolved.
pub fn gather(slice: anytype, index: anytype) @Vector(
    @typeInfo(@TypeOf(index)).vector.len,
    @typeInfo(@TypeOf(slice)).pointer.child,
) {
    const vector_len = @typeInfo(@TypeOf(index)).vector.len;
    const Elem = @typeInfo(@TypeOf(slice)).pointer.child;
    var result: [vector_len]Elem = undefined;
    comptime var vec_i = 0;
    inline while (vec_i < vector_len) : (vec_i += 1) {
        result[vec_i] = slice[index[vec_i]];
    }
    return result;
}

/// Same as gather, but it works with arrays instead of slices (and is strangely faster?)
/// Interestingly, Zig seems to have issues casting an array into a slice in order to use the
/// gather above. I might need to file a bug with Zig on this one.
pub fn gatherArray(array: anytype, index: anytype) @Vector(
    @typeInfo(@TypeOf(index)).vector.len,
    @typeInfo(@TypeOf(array)).array.child,
) {
    const vector_len = @typeInfo(@TypeOf(index)).vector.len;
    const Elem = @typeInfo(@TypeOf(array)).array.child;
    var result: [vector_len]Elem = undefined;
    comptime var vec_i = 0;
    inline while (vec_i < vector_len) : (vec_i += 1) {
        result[vec_i] = array[index[vec_i]];
    }
    return result;
}

test "vector gather" {
    const hello: []const u8 = "hello world";
    const index: @Vector(3, usize) = .{ 1, 3, 5 };
    const result = gather(hello, index);
    try std.testing.expect(@TypeOf(result) == @Vector(3, u8));
    try std.testing.expect(result[0] == 'e');
    try std.testing.expect(result[1] == 'l');
    try std.testing.expect(result[2] == ' ');
}

test "vector gather array" {
    const array = [3]u8{ 0, 1, 2 };
    const index: @Vector(3, usize) = .{ 0, 1, 1 };
    const result = gatherArray(array, index); // error: expected integer, float, bool, or pointer for the vector element type; found '[3]u8'
    // const result = gather(@as([]const u8, @ptrCast(&array)), index); //works
    try std.testing.expect(result[0] == 0);
    try std.testing.expect(result[1] == 1);
    try std.testing.expect(result[2] == 1);
}
