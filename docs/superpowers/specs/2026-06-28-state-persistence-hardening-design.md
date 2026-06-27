# WS-A: 状态持久化加固（State Persistence Hardening）

- **日期**: 2026-06-28
- **工单**: WS-A（6 工单分解中的第 1 条，独立地基）
- **范围**: 仅 `src/state.ts` + `tests/state.test.ts`
- **状态**: Draft（待评审）

## 背景

`state.json` 是 cdog 的唯一持久化状态源，被多个并发进程读写：主 `cdog` CLI、detached
log-watcher、detached pane-watcher，以及 hook 触发的 `cdog notify` 子进程。所有写都经过
`state.ts` 的锁保护（`withStateLock` / `mutateAgent`）。

当前实现存在一条会**永久丢失全部 agent 状态**的链路：

1. **非原子写** — `saveStateRaw`（`src/state.ts:97-101`）docstring 声称 "write to temp +
   rename"，实际却是裸 `writeFileSync(STATE_PATH, ...)`。进程在写到一半被杀 / 断电 /
   磁盘抖动 → `state.json` 截断或半写。
2. **损坏被静默清空** — `loadStateRaw`（`src/state.ts:86-95`）的 `catch { return {} }` 在
   JSON 解析失败时直接返回空对象。下一次任何 `mutateAgent` / `saveState` 把空对象原子地
   写回 → **原始（可能可恢复的）数据被永久覆盖**。

watcher 每隔几秒就写一次状态，这个丢失窗口在长时间无人值守运行（cdog 的核心场景）下不可忽视。

## 目标 / 非目标

**目标**
- 斩断上述数据丢失链：让"写到一半"的损坏在 POSIX 语义下不可能发生。
- 即便发生其他来源的损坏（磁盘错误、人工误编辑），也绝不静默覆盖：先备份、再喊、再清空。
- 保留现有对外契约：`loadState()` 在无/空/损坏时仍返回 `{}`（`tests/state.test.ts` 已断言）。

**非目标（留给后续工单）**
- 锁的 CPU 忙等问题（`acquireLock` 的 spin-wait）→ **WS-D**。
- watcher 高频抢锁的性能问题 → **WS-D**。
- 关键路径静默吞错的全局治理 → **WS-E**。

## 设计

### Fix 1：原子写 `saveStateRaw`

把裸 `writeFileSync(STATE_PATH, ...)` 替换为 POSIX 原子的 **temp + fsync + rename**：

1. 临时文件路径 `STATE_PATH + '.tmp.' + process.pid`，位于 **同目录（CDOG_DIR）** → 同文件系统 →
   `rename` 原子。
2. `openSync(tmp, 'wx')` → `writeSync(fd, json)` → `fsyncSync(fd)` → `closeSync(fd)`。
   - `fsync` 确保内容落盘后再 rename，防断电时新文件也是空的。
3. `renameSync(tmp, STATE_PATH)` —— 原子替换，读者要么看到旧文件、要么看到完整新文件，
   永远看不到半写状态。
4. 任一步失败：`finally` 中 `unlinkSync(tmp)`（`{ force: true }` 容错），再向上抛错。

**临时文件名带 pid 仅作保险**：所有写都在 `acquireLock()` 串行保护下，理论上无并发写同一
临时名；pid 后缀防止任何绕过锁的异常路径互相踩踏。

docstring 修正为与实现一致（其实它本来就描述 temp + rename，这次实现才真正对上）。

### Fix 2：损坏不清空 `loadStateRaw`

`catch` 块不再默默 `return {}`，改为：

1. 把损坏文件**备份**为 `STATE_PATH + '.corrupt.' + <timestamp>`（timestamp 用
   `Date.now()`；若该备份名已存在则追加序号避免覆盖）。
2. **大声记录**：`logAgentEvent('cdog', 'state.json corrupt — backed up to <path>, starting fresh')`
   并 `console.warn(...)` 同样信息到 stderr。
3. **仍返回 `{}`** —— 保留契约，`tests/state.test.ts:59-63` 继续绿。

**为何不抛错 / 不进只读模式**：`loadState` 在 detached watcher 的热循环和频繁的 hook 子进程
里被调用；抛错会让这些后台进程反复崩溃，违背 cdog "无人值守"的设计初衷。备份 + 喊一声 +
fresh start 是安全与可用性的平衡。备份保留了人工恢复的可能。

### 双向掐断数据丢失链

- 原子写 → "写到一半"型损坏几乎不可能发生。
- 即使损坏（其他来源），也先备份再清空 → 原始数据不会被下一次 save 静默覆盖。

## 受影响文件

| 文件 | 改动 |
|---|---|
| `src/state.ts` | `saveStateRaw`（原子写）、`loadStateRaw`（备份 + 日志）；docstring 修正 |
| `tests/state.test.ts` | 追加 2 个用例（见下） |

无对外 API 变更；`loadState/saveState/mutateAgent/...` 签名与语义不变。

## 测试

追加到 `tests/state.test.ts`：

1. **原子写：rename 失败时 state.json 保持完整**
   - 预置一个合法 `state.json`（含一个 agent）。
   - mock/stub `renameSync` 在本次调用抛错（vitest `vi.spyOn`）。
   - 触发 `saveState({...})` 并捕获异常。
   - 断言：`state.json` 仍是预置的完整内容（未被截断）；临时文件 `<tmp>.<pid>` 已被清理。

2. **损坏文件被备份且不静默清空**
   - 写入坏 JSON（如 `'not json{'`）到 `state.json`。
   - 调 `loadState()`。
   - 断言：返回 `{}`；存在至少一个 `state.json.corrupt.<ts>` 备份文件，其内容 == 坏 JSON 原文。

现有用例（`returns empty object when state file is corrupt`）继续通过。

## 风险

- **fsync 开销**：每次 state 写多一次 `fsync`。state 写不在极热路径（锁 + JSON 序列化本身更贵），
  且 cdog 写频率为秒级，可接受。若 WS-D 之后证明是瓶颈，再评估。
- **备份文件堆积**：损坏本就少见，且每次损坏只产一个备份；长期可加一条"启动时清理超过 N 天的
  `.corrupt.*`"的维护逻辑，但属 YAGNI，暂不做（记入 WS-F 候选）。
- **同目录必须同文件系统**：`STATE_PATH` 在 `CDOG_DIR`（默认 `~/.cdog`）下，临时文件同目录，
  满足 rename 原子性前提。若用户把 `CDOG_DIR` 设成 symlink 跨文件系统，rename 仍可用（POSIX
  保证 rename 原子，跨文件系统时内核做 copy+unlink，可能非原子）—— 边界，记入风险，不特殊处理。

## 验收标准

- [ ] `saveStateRaw` 通过 temp + fsync + rename 原子写入；失败时清理临时文件。
- [ ] `loadStateRaw` 在 JSON 解析失败时备份原文件、记日志、返回 `{}`。
- [ ] `loadState()` 对 missing / empty / corrupt 三种情况仍返回 `{}`（契约不变）。
- [ ] 新增 2 个测试用例通过；现有 `tests/state.test.ts` 全绿。
- [ ] `npm test` 全绿。
