# Next.js Frontend Architecture


### 5.1 Stack
- Next.js 14 (App Router)
- TypeScript
- Tailwind CSS
- shadcn/ui
- `@dnd-kit/core` + `@dnd-kit/sortable`
- `zustand` (client state)
- `@tanstack/react-query` (server state)
- `wavesurfer.js` (audio preview)
- `zod` (form validation)

### 5.2 Cấu trúc thư mục

```
apps/web/
├── app/
│   ├── (auth)/
│   │   ├── login/page.tsx
│   │   └── callback/page.tsx
│   ├── (dashboard)/
│   │   ├── layout.tsx
│   │   ├── projects/page.tsx
│   │   ├── projects/[projectId]/
│   │   │   ├── page.tsx
│   │   │   └── episodes/[episodeId]/
│   │   │       ├── script/page.tsx
│   │   │       ├── payload/page.tsx
│   │   │       ├── generation/page.tsx
│   │   │       ├── library/page.tsx
│   │   │       ├── composer/page.tsx
│   │   │       ├── transcript/page.tsx
│   │   │       └── export/page.tsx
│   │   └── layout.tsx
│   └── api/
├── components/
│   ├── script/
│   ├── payload/
│   ├── generation/
│   ├── library/
│   ├── composer/
│   ├── transcript/
│   └── ui/
├── lib/
│   ├── api-client.ts
│   ├── query-keys.ts
│   ├── audio.ts
│   └── format.ts
├── hooks/
│   ├── useEpisode.ts
│   ├── useGeneration.ts
│   ├── useSse.ts
│   └── useAudioPlayer.ts
├── stores/
│   ├── composer.store.ts
│   └── script.store.ts
└── types/
    └── api.ts
```

### 5.3 Routing

| Route | Màn hình |
|-------|----------|
| `/projects` | Danh sách project |
| `/projects/[id]` | Episodes trong project |
| `/projects/[id]/episodes/[eid]/script` | Script Editor |
| `/projects/[id]/episodes/[eid]/payload` | Payload Editor |
| `/projects/[id]/episodes/[eid]/generation` | Generation Monitor |
| `/projects/[id]/episodes/[eid]/library` | Audio Library |
| `/projects/[id]/episodes/[eid]/composer` | Audio Composer |
| `/projects/[id]/episodes/[eid]/transcript` | Transcript + SRT |
| `/projects/[id]/episodes/[eid]/export` | Export |

### 5.4 React Query keys

```ts
export const qk = {
  projects: ['projects'] as const,
  episodes: (pid: string) => ['projects', pid, 'episodes'] as const,
  episode: (eid: string) => ['episodes', eid] as const,
  script: (eid: string) => ['episodes', eid, 'script'] as const,
  characters: (eid: string) => ['episodes', eid, 'characters'] as const,
  batches: (eid: string) => ['episodes', eid, 'batches'] as const,
  batch: (bid: string) => ['batches', bid] as const,
  audios: (eid: string) => ['episodes', eid, 'audios'] as const,
  compositions: (eid: string) => ['episodes', eid, 'compositions'] as const,
  transcription: (aid: string) => ['audio', aid, 'transcription'] as const,
};
```

### 5.5 SSE hook

```ts
export function useSse<T>(url: string, onMessage: (data: T) => void) {
  useEffect(() => {
    const es = new EventSource(url, { withCredentials: true });
    es.onmessage = (e) => onMessage(JSON.parse(e.data));
    es.onerror = () => es.close();
    return () => es.close();
  }, [url]);
}
```

### 5.6 Composer store

```ts
type TimelineItem = {
  id: string;
  audioId: string;
  order: number;
  trimStart?: number;
  trimEnd?: number;
};

export const useComposer = create<ComposerState>((set) => ({
  items: [],
  addItem: ({ audioId }) =>
    set((s) => ({
      items: [...s.items, { id: crypto.randomUUID(), audioId, order: s.items.length }],
    })),
  reorder: (from, to) =>
    set((s) => {
      const items = [...s.items];
      const [moved] = items.splice(from, 1);
      items.splice(to, 0, moved);
      return { items: items.map((it, i) => ({ ...it, order: i })) };
    }),
  removeItem: (id) =>
    set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
  reset: () => set({ items: [] }),
}));
```

### 5.7 Payload Editor layout

```
┌──────────────────────────────────────────────┐
│ ElevenLabs Payload                           │
├──────────────────────────────────────────────┤
│ Model      [ eleven_v3                    ▼ ]│
│ Language   [ en                           ▼ ]│
│                                              │
│ Dialogue                                     │
│ ┌──────────────────────────────────────────┐ │
│ │ Sarah                                    │ │
│ │ Voice: Rachel                            │ │
│ │ [gently] I thought you forgot about me.  │ │
│ └──────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────┐ │
│ │ Daniel                                   │ │
│ │ Voice: Adam                              │ │
│ │ [quietly] How could I forget?            │ │
│ └──────────────────────────────────────────┘ │
│                                              │
│ [ Add dialogue ]                             │
│ [ Validate ]                 [ Generate ]    │
└──────────────────────────────────────────────┘

Toggle: [ Visual ] [ JSON ]
```

---

