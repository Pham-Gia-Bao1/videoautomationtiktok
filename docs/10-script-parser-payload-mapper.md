# Script Parser & Payload Mapper


### 10.1 Input format

```
Sarah: I thought you forgot about me.

Daniel: How could I forget?
```

Patterns:
- `^([A-Za-z0-9 _\-'.]+):\s*(.+)$` — speaker + text.
- Dòng trống: bỏ qua.
- Dòng không match: emit warning.

### 10.2 ParseOutput

```ts
type ParseOutput = {
  characters: { key: string; name: string }[];
  lines: { sequence: number; speaker: string; text: string }[];
  warnings: { code: string; line: number; raw: string }[];
  unparsed: { line: number; raw: string }[];
};
```

### 10.3 PayloadMapper input/output

Input:
```ts
{
  lines: ScriptLine[];
  voiceMappings: Record<string, string>;
  modelId: string;
  languageCode: string;
  settings?: Record<string, unknown>;
  seed?: number | null;
  applyTextNormalization?: 'auto' | 'on' | 'off';
}
```

Output:
```ts
{
  payload: CreateDialogueRequest;
  missingMappings: string[];
  uniqueVoiceCount: number;
}
```

### 10.4 Edge cases

| Case | Handling |
|------|----------|
| Script rỗng | 400 VALIDATION_FAILED |
| 1 nhân vật | OK |
| Tên chứa `:` | Escape `Name\:` |
| Audio tag giữa text | Giữ nguyên |
| Text chứa `\n` | Nối bằng space |
| Character name trùng sau slug | Merge + warning |

---

