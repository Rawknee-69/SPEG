// ABI compatibility: the vendored ghostty-write-pty.wasm imports env.t3_write_pty.
// Keep this name in lockstep with that binary's import section (rebuild via
// build-libghostty-wasm.sh to rename); renaming it here breaks instantiation.
extern "env" fn t3_write_pty(terminal: u32, userdata: u32, data: u32, len: u32) void;

export fn ghostty_write_pty(terminal: u32, userdata: u32, data: u32, len: u32) void {
    t3_write_pty(terminal, userdata, data, len);
}
