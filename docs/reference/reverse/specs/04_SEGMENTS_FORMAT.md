# 04 · segments.bin / seg.xN 格式

## 目录布局

```
~/Library/Application Support/com.NeatDownloadManager/<downloadId>/
├── segments.bin      # 段表（小文件，24 * N 字节）
├── seg.x0
├── seg.x1
├── …
├── seg.x31           # 最多观察到与 MaxConnections=32 对齐
└── LogFile.txt
```

- 完成并清理后，有的目录只剩 `LogFile.txt`
- 未完成任务通常同时存在 `segments.bin` + 若干 `seg.x*`

## segments.bin 结构（高置信，已修正）

**记录大小：24 字节**，小端序。

```c
#pragma pack(push, 1)
struct NeatSegmentRecord {
    int16_t orderOrId;    // 常见与 segmentId 相同；列表序/主 id
    int16_t segmentId;    // ★ 对应磁盘文件 seg.x{segmentId}（不是“状态枚举”）
    int32_t nextId;       // 链表下一 segmentId；-1 (0xFFFFFFFF) = 尾
    int64_t start;        // 逻辑文件内起始偏移（含）
    int64_t end;          // 逻辑文件内结束偏移（含）
};
#pragma pack(pop)
// sizeof == 24
```

> **勘误：** 早期文档把第二字段写成 `state`。对全库 `segments.bin` 统计后否定：  
> 该字段取值与目录里 `seg.xN` 的 **N 一一对应**（含合并后稀疏 id：72、80、82…），不是 0/1/2 状态机。

### 实证（任务 4125，2 段，文件总长 18207337）

日志：

```
Socket1 Range = 0-
→ Content-Range: bytes 0-18207336/18207337
Socket2 Range = 9595188-18207336
```

`segments.bin`（48 字节）解析：

| order | segId | next | start | end | 文件 |
|------:|------:|-----:|------:|----:|------|
| 0 | 0 | 1 | 0 | 9595187 | `seg.x0` |
| 1 | 1 | -1 | 9595188 | 18207336 | `seg.x1` |

与日志 Range **完全吻合**。

### 单段

```
order=0, segId=0, next=-1, start=0, end=<lastInclusive>
```

### next 链表

- `nextId` 指向另一条记录的 **segmentId**（不是数组下标）  
- 动态分段/合并后 id 可稀疏；`seg.x*` 文件名跟随 segmentId  
- 暂停任务样本常见：32 连接 → 约 32～33 条记录，id 多连续 0..31

## seg.xN

- 原始字节负载，对应某 segment 的数据  
- N 与 record.index 对应（不完全保证连续）  
- 最终合并按 start 偏移写入目标文件（引擎内 `NeatFileUnix`）

## 加载日志

```
Segments were loaded from segments.bin file.
TS Segments were loaded from segments.bin file.
) doesn't exist or has been changed so SegmentManager uses default OutPath
Can not Add new Segment to config-file.
Can not update Ts-Segment End-Pos
```

## 解析器参考伪代码

```python
import struct
def parse_segments(path):
    data = open(path,'rb').read()
    assert len(data) % 24 == 0
    segs = []
    for i in range(0, len(data), 24):
        index, state, nxt, start, end = struct.unpack_from('<hhiqq', data, i)
        segs.append(dict(index=index, state=state, next=nxt, start=start, end=end))
    return segs
```

## 待证实

1. `orderOrId` 与 `segmentId` 何时会不同（多数样本相等）  
2. HLS TS 模式是否共用同一 24 字节布局（日志有独立 TS 文案）  
3. 合并瞬间如何改写链表 / 删除旧 `seg.x*`
