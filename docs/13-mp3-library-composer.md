# MP3 Library & Composer


### 13.1 Library UI

```
┌────────────────────────────────────────────────┐
│ Audio Library — Episode: Love After Distance   │
├────────────────────────────────────────────────┤
│ Filter: [ All ] [ Batch #1 ] [ Batch #2 ]      │
│                                                │
│ ┌──────────┐  ┌──────────┐  ┌──────────┐      │
│ │ Chunk 01 │  │ Chunk 02 │  │ Chunk 03 │      │
│ │ Batch #1 │  │ Batch #1 │  │ Batch #1 │      │
│ │ ▶ 0:42   │  │ ▶ 0:55   │  │ ▶ 0:38   │      │
│ └──────────┘  └──────────┘  └──────────┘      │
└────────────────────────────────────────────────┘
```

### 13.2 Composer layout

```
┌───────────────────────┬───────────────────────┐
│ Audio Pool            │ Timeline              │
│                       │                       │
│ [Chunk 01][Chunk 02]  │ ┌─1─┬─2─┬─3─┬─4─┐    │
│ [Chunk 03][Final 01]  │ │ A │ B │ C │   │    │
│                       │ └───┴───┴───┴───┘    │
│                       │ [ Merge ] [ Save ]    │
└───────────────────────┴───────────────────────┘
```

### 13.3 TimelineItem schema

```ts
type TimelineItem = {
  id: string;
  audioId: string;
  orderIndex: number;
  gapMs: number;
  trimStartMs?: number;
  trimEndMs?: number;
};
```

### 13.4 Composition states
`DRAFT → MERGING → READY` hoặc `FAILED`.

---

