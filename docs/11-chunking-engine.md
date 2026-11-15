# Chunking Engine


### 11.1 Nguyên tắc
- **≤ 2,000 characters / chunk**.
- Không cắt giữa **turn**.
- Không cắt giữa **câu**.
- Giữ `start_line` / `end_line`.

### 11.2 Algorithm

```
FUNCTION chunk(lines, charLimit = 2000):
  chunks = []
  current = { inputs: [], chars: 0, startLine: null, endLine: null }

  FOR line IN lines:
    lineLen = length(line.text)
    nextLen = current.chars + lineLen

    IF nextLen > charLimit AND current.inputs.length > 0:
      chunks.push(current)
      current = { inputs: [], chars: 0, startLine: null, endLine: null }

    IF lineLen > charLimit:
      subChunks = splitOversizedLine(line, charLimit)
      FOR sc IN subChunks: push as its own chunk
      CONTINUE

    current.inputs.push(line)
    current.chars += lineLen
    IF current.startLine == null: current.startLine = line.sequence
    current.endLine = line.sequence

  IF current.inputs.length > 0: chunks.push(current)
  RETURN chunks
```

### 11.3 Oversized line handling
1. Split theo câu (`[.!?…]`).
2. Split theo mệnh đề (`[;,]`).
3. Hard cut nếu vẫn > limit → warning `LINE_HARD_CUT`.

### 11.4 Validation trước enqueue
- Mỗi chunk `characterCount ≤ 2000`.
- Mỗi chunk `inputCount ≥ 1`.
- Mỗi chunk `unique voice_ids ≤ 10`.
- `startLine`, `endLine` liên tục.

---

