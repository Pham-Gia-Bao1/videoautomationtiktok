'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

type Project = { id: string; name: string };
type Episode = { id: string; projectId: string; title: string; languageCode: string; defaultModelId: string; status: string };
type Character = { key: string; name: string };
type ScriptLine = { sequence: number; speaker: string; text: string };
type Warning = { code: string; line: number; message: string };
type Script = { id: string; rawText: string; version: number };
type Audio = { id: string; kind: 'chunk' | 'final'; label: string; sizeBytes: number; durationSeconds: number | null };
type Chunk = { id: string; chunkIndex: number; status: string; errorMessage: string | null; audioId: string | null };
type Batch = { id: string; label: string; status: string; completedChunks: number; failedChunks: number; totalChunks: number };
type Composition = { id: string; name: string; status: string; outputAudioId: string | null; errorMessage: string | null };
type Transcription = { id: string; audioId: string; text: string; status: string };
type Video = { id: string; audioId: string; title: string; status: string; sourceMode?: 'elevenlabs' | 'uploaded' | 'cover' | 'ghost'; ghostStyle?: string | null; aspectRatio?: '16:9' | '9:16' | '1:1'; resolution?: 720 | 1080; sizeBytes: number; errorMessage: string | null; createdAt: string };
type VideoClip = { id: string; title: string; mimeType: string; sizeBytes: number; durationSeconds: number; createdAt: string };
type Subtitle = { id: string; transcriptionId: string; format: 'srt' | 'vtt'; content: string; createdAt: string };
type Voice = { voiceId: string; name: string; category?: string; previewUrl?: string };
type EpisodeData = {
  script: Script | null;
  parsed: { characters: Character[]; lines: ScriptLine[]; warnings: Warning[] } | null;
  characters: Array<Character & { id: string }>;
  voiceMappings: Array<{ characterId: string; voiceId: string }>;
  batches: Batch[];
  audios: Audio[];
  compositions: Composition[];
  transcriptions: Transcription[];
  subtitles: Subtitle[];
  videos: Video[];
  videoClips: VideoClip[];
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message ?? data?.error ?? `Request failed (${response.status}).`;
    throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
  }
  return data as T;
}

const initialScript = `Maya: [curious] Have you ever wondered what the ocean sounds like at night?
Leo: [thoughtful] I imagine it's quieter than we think. Maybe the waves are telling stories.
Maya: [laughing] Then let's stay a little longer and listen.`;

const tabs = [
  ['script', '01', 'Script'],
  ['voices', '02', 'Voices'],
  ['generation', '03', 'Generate'],
  ['library', '04', 'Library'],
  ['composer', '05', 'Composer'],
  ['transcript', '06', 'Transcript'],
  ['video', '07', 'Video'],
] as const;
type Tab = (typeof tabs)[number][0];

export default function Home() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [projectId, setProjectId] = useState('');
  const [episodeId, setEpisodeId] = useState('');
  const [newProjectName, setNewProjectName] = useState('My podcast');
  const [newEpisodeTitle, setNewEpisodeTitle] = useState('New episode');
  const [tab, setTab] = useState<Tab>('script');
  const [script, setScript] = useState(initialScript);
  const scriptDirty = useRef(false);
  const loadedScriptEpisode = useRef('');
  const mappingLoadedEpisode = useRef('');
  const videoTitleEpisode = useRef('');
  const [scriptRecord, setScriptRecord] = useState<Script | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [lines, setLines] = useState<ScriptLine[]>([]);
  const [warnings, setWarnings] = useState<Warning[]>([]);
  const [voiceIds, setVoiceIds] = useState<Record<string, string>>({});
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voiceError, setVoiceError] = useState('');
  const [batches, setBatches] = useState<Batch[]>([]);
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [audios, setAudios] = useState<Audio[]>([]);
  const [compositions, setCompositions] = useState<Composition[]>([]);
  const [transcriptions, setTranscriptions] = useState<Transcription[]>([]);
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [videos, setVideos] = useState<Video[]>([]);
  const [previewVideoId, setPreviewVideoId] = useState('');
  const [videoClips, setVideoClips] = useState<VideoClip[]>([]);
  const [videoAudioId, setVideoAudioId] = useState('');
  const [videoTitle, setVideoTitle] = useState('Episode video');
  const [videoMode, setVideoMode] = useState<'elevenlabs' | 'uploaded' | 'ghost'>('elevenlabs');
  const [ghostStyle, setGhostStyle] = useState('clean');
  const [ghostStatus, setGhostStatus] = useState<{ installed: boolean; authenticated: boolean; styles: string[] }>({ installed: false, authenticated: false, styles: [] });
  const [videoAspectRatio, setVideoAspectRatio] = useState<'16:9' | '9:16' | '1:1'>('16:9');
  const [videoResolution, setVideoResolution] = useState<720 | 1080>(720);
  const [videoPrompt, setVideoPrompt] = useState('');
  const [videoFiles, setVideoFiles] = useState<File[]>([]);
  const [selectedVideoClipIds, setSelectedVideoClipIds] = useState<string[]>([]);
  const [videoSubtitleId, setVideoSubtitleId] = useState('');
  const [selectedAudioIds, setSelectedAudioIds] = useState<string[]>([]);
  const [compositionName, setCompositionName] = useState('Final episode');
  const [selectedAudioId, setSelectedAudioId] = useState('');
  const [subtitleContent, setSubtitleContent] = useState('');
  const [subtitleId, setSubtitleId] = useState('');
  const [payloadPreview, setPayloadPreview] = useState('');
  const [payloadView, setPayloadView] = useState<'visual' | 'json'>('visual');
  const [normalization, setNormalization] = useState<'auto' | 'on' | 'off'>('auto');
  const [seed, setSeed] = useState('');
  const [timelineGaps, setTimelineGaps] = useState<Record<string, number>>({});
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [apiOnline, setApiOnline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [languageCode, setLanguageCode] = useState('en');
  const [modelId, setModelId] = useState('eleven_v3');

  const refreshProjects = useCallback(async () => {
    const result = await request<{ projects: Project[] }>('/api/projects');
    setProjects(result.projects);
    if (!projectId && result.projects[0]) setProjectId(result.projects[0].id);
  }, [projectId]);

  const loadVoices = useCallback(async () => {
    setVoiceError('');
    try {
      const result = await request<{ voices: Voice[] }>('/api/voices');
      setVoices(result.voices);
    } catch (cause) {
      setVoiceError(cause instanceof Error ? cause.message : 'Could not load voices.');
    }
  }, []);

  const loadGhostStatus = useCallback(async () => {
    try {
      setGhostStatus(await request<{ installed: boolean; authenticated: boolean; styles: string[] }>('/api/ghost-editor/status'));
    } catch {
      setGhostStatus({ installed: false, authenticated: false, styles: [] });
    }
  }, []);

  const refreshEpisode = useCallback(async (id: string) => {
    if (!id) return;
    const result = await request<EpisodeData & { episode: Episode }>(`/api/episodes/${id}`);
    if (loadedScriptEpisode.current !== id) {
      scriptDirty.current = false;
      loadedScriptEpisode.current = id;
      mappingLoadedEpisode.current = '';
    }
    setScriptRecord(result.script);
    if (!scriptDirty.current) setScript(result.script?.rawText ?? initialScript);
    setCharacters(result.parsed?.characters ?? []);
    setLines(result.parsed?.lines ?? []);
    setBatches(result.batches);
    setAudios(result.audios);
    setCompositions(result.compositions);
    setTranscriptions(result.transcriptions);
    setSubtitles(result.subtitles);
    setVideos(result.videos);
    setVideoClips(result.videoClips);
    setLanguageCode(result.episode.languageCode);
    setModelId(result.episode.defaultModelId);
    setSelectedAudioId((current) => current || result.audios.find((audio) => audio.kind === 'final')?.id || '');
    setVideoAudioId((current) => result.audios.some((audio) => audio.id === current && audio.kind === 'final')
      ? current
      : result.audios.find((audio) => audio.kind === 'final')?.id ?? '');
    if (videoTitleEpisode.current !== id) {
      videoTitleEpisode.current = id;
      setVideoTitle(`${result.episode.title} video`);
      setVideoPrompt(`${result.episode.title}, cinematic podcast visuals, atmospheric landscape, gentle camera movement`);
      setVideoFiles([]);
      setSelectedVideoClipIds([]);
      setVideoSubtitleId('');
    }
    const charactersById = new Map(result.characters.map((character) => [character.id, character.key]));
    if (mappingLoadedEpisode.current !== id) {
      setVoiceIds(Object.fromEntries(result.voiceMappings.flatMap((mapping) => {
        const key = charactersById.get(mapping.characterId);
        return key ? [[key, mapping.voiceId] as const] : [];
      })));
      mappingLoadedEpisode.current = id;
    }
    const chunkAudioIds = new Set(result.audios.filter((audio) => audio.kind === 'chunk').map((audio) => audio.id));
    setSelectedAudioIds((current) => current.filter((audioId) => chunkAudioIds.has(audioId)));
    setWarnings(result.parsed?.warnings ?? []);
  }, []);

  useEffect(() => {
    request<{ status: string }>('/api/health')
      .then(() => setApiOnline(true))
      .catch(() => setApiOnline(false));
    refreshProjects().catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load projects.'));
    void loadVoices();
    void loadGhostStatus();
  }, [loadGhostStatus, loadVoices, refreshProjects]);

  useEffect(() => {
    if (!projectId) {
      setEpisodes([]);
      setEpisodeId('');
      return;
    }
    request<{ episodes: Episode[] }>(`/api/projects/${projectId}/episodes`)
      .then((result) => {
        setEpisodes(result.episodes);
        if (!result.episodes.some((episode) => episode.id === episodeId)) setEpisodeId(result.episodes[0]?.id ?? '');
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load episodes.'));
  }, [projectId, episodeId]);

  useEffect(() => {
    if (!episodeId) return;
    refreshEpisode(episodeId).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load episode.'));
  }, [episodeId, refreshEpisode]);

  useEffect(() => {
    if (!episodeId) return;
    const timer = setInterval(() => {
      refreshEpisode(episodeId).catch(() => undefined);
    }, 2500);
    return () => clearInterval(timer);
  }, [episodeId, refreshEpisode]);

  useEffect(() => {
    if (!batches.length) return;
    const active = batches.find((batch) => ['QUEUED', 'RUNNING'].includes(batch.status));
    if (!active) return;
    request<{ chunks: Chunk[] }>(`/api/generation-batches/${active.id}`)
      .then((result) => setChunks(result.chunks))
      .catch(() => undefined);
  }, [batches]);

  useEffect(() => {
    const matchingSubtitles = subtitles.filter((subtitle) => transcriptions.some((transcription) =>
      transcription.id === subtitle.transcriptionId &&
      transcription.audioId === videoAudioId &&
      transcription.status === 'COMPLETED'));
    setVideoSubtitleId((current) => matchingSubtitles.some((subtitle) => subtitle.id === current)
      ? current
      : matchingSubtitles[matchingSubtitles.length - 1]?.id ?? '');
  }, [subtitles, transcriptions, videoAudioId]);

  const mappedCount = useMemo(() => characters.filter((character) => voiceIds[character.key]?.trim()).length, [characters, voiceIds]);
  const wordCount = script.trim() ? script.trim().split(/\s+/).length : 0;
  const activeBatch = batches[0];

  async function createProject() {
    const name = newProjectName.trim();
    if (!name) {
      setError('Enter a project name first.');
      return;
    }
    setBusy(true);
    try {
      const result = await request<{ project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify({ name }) });
      await refreshProjects();
      setProjectId(result.project.id);
      setNewProjectName('');
      setNotice('Project created.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create project.');
    } finally { setBusy(false); }
  }

  async function createEpisode() {
    if (!projectId) return;
    const title = newEpisodeTitle.trim();
    if (!title) {
      setError('Enter an episode title first.');
      return;
    }
    setBusy(true);
    try {
      const result = await request<{ episode: Episode }>(`/api/projects/${projectId}/episodes`, {
        method: 'POST', body: JSON.stringify({ title, languageCode, modelId }),
      });
      setEpisodes((current) => [...current, result.episode]);
      setEpisodeId(result.episode.id);
      setNewEpisodeTitle('');
      setNotice('Episode created.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create episode.');
    } finally { setBusy(false); }
  }

  async function saveScript() {
    if (!episodeId) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await request<{ script: Script; characters: Character[]; lines: ScriptLine[]; warnings: Warning[] }>(
        `/api/episodes/${episodeId}/scripts`,
        { method: 'POST', body: JSON.stringify({ rawText: script, mergeAdjacent: true }) },
      );
      setScriptRecord(result.script);
      scriptDirty.current = false;
      setCharacters(result.characters);
      setLines(result.lines);
      setWarnings(result.warnings);
      await refreshEpisode(episodeId);
      setTab('voices');
      setNotice(`Saved script v${result.script.version}; detected ${result.characters.length} speakers.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save script.');
    } finally { setBusy(false); }
  }

  async function saveVoiceMappings() {
    if (!episodeId) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await request<{ voiceMappings: unknown[] }>(`/api/episodes/${episodeId}/voice-mappings`, {
        method: 'PUT',
        body: JSON.stringify({ mappings: characters.filter((character) => voiceIds[character.key]?.trim()).map((character) => ({
          characterKey: character.key,
          voiceId: voiceIds[character.key].trim(),
          voiceName: voices.find((voice) => voice.voiceId === voiceIds[character.key])?.name ?? null,
        })) }),
      });
      setNotice(`Saved ${result.voiceMappings.length} voice mappings.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save voice mappings.');
    } finally { setBusy(false); }
  }

  async function previewPayload() {
    if (!scriptRecord) return;
    setBusy(true); setError('');
    try {
      const result = await request<{ payload: unknown; chunked: unknown[]; warnings: Array<{ message: string }> }>(`/api/scripts/${scriptRecord.id}/build-payload`, {
        method: 'POST',
        body: JSON.stringify({
          modelId,
          languageCode,
          voiceMappings: voiceIds,
          applyTextNormalization: normalization,
          seed: seed.trim() ? Number(seed) : null,
        }),
      });
      setPayloadPreview(JSON.stringify({ payload: result.payload, chunked: result.chunked, warnings: result.warnings }, null, 2));
      setNotice(`Payload ready: ${result.chunked.length} chunk(s).`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not build the ElevenLabs payload.');
    } finally { setBusy(false); }
  }

  async function createAndStartBatch() {
    if (!episodeId || !scriptRecord) {
      setError('Save a script before generating audio.');
      setTab('script');
      return;
    }
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await request<{ batch: Batch; chunks: Chunk[]; warnings: Array<{ message: string }> }>('/api/generation-batches', {
        method: 'POST',
        body: JSON.stringify({
          episodeId, scriptId: scriptRecord.id, modelId, languageCode, voiceMappings: voiceIds,
          applyTextNormalization: normalization, seed: seed.trim() ? Number(seed) : null,
        }),
      });
      setChunks(result.chunks);
      setBatches((current) => [result.batch, ...current]);
      const start = await request<{ status: string }>(`/api/generation-batches/${result.batch.id}/start`, { method: 'POST', body: '{}' });
      setNotice(`${start.status}: ${result.batch.totalChunks} chunk(s) queued.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start generation.');
    } finally { setBusy(false); }
  }

  async function retryBatch(batch: Batch) {
    setBusy(true); setError('');
    try {
      const result = await request<{ chunkIds: string[] }>(`/api/generation-batches/${batch.id}/retry`, { method: 'POST', body: '{}' });
      setNotice(`${result.chunkIds.length} failed chunk(s) queued for retry.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not retry failed chunks.');
    } finally { setBusy(false); }
  }

  async function createComposition() {
    if (!episodeId || !selectedAudioIds.length) {
      setError('Add at least one audio chunk to the timeline.');
      return;
    }
    setBusy(true); setError('');
    try {
      const created = await request<{ composition: Composition }>('/api/compositions', {
        method: 'POST', body: JSON.stringify({ episodeId, name: compositionName }),
      });
      await request(`/api/compositions/${created.composition.id}/items`, {
        method: 'PATCH',
        body: JSON.stringify({ items: selectedAudioIds.map((audioId, orderIndex) => ({ audioId, orderIndex, gapMs: timelineGaps[audioId] ?? 300 })) }),
      });
      await request(`/api/compositions/${created.composition.id}/merge`, { method: 'POST', body: '{}' });
      setCompositions((current) => [created.composition, ...current]);
      setNotice('Composition is merging. It will appear in the library when ready.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not merge the composition.');
    } finally { setBusy(false); }
  }

  async function transcribeAudio() {
    if (!selectedAudioId) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await request<{ transcription: Transcription }>(`/api/audio/${selectedAudioId}/transcribe`, { method: 'POST', body: '{}' });
      setTranscriptions((current) => [result.transcription, ...current]);
      setNotice('Transcription completed.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not transcribe audio.');
    } finally { setBusy(false); }
  }

  async function generateSubtitles(transcription: Transcription, format: 'srt' | 'vtt' = 'srt') {
    setBusy(true); setError('');
    try {
      const result = await request<{ subtitle: { id: string; content: string } }>(`/api/transcriptions/${transcription.id}/generate-srt`, {
        method: 'POST', body: JSON.stringify({ format }),
      });
      setSubtitleId(result.subtitle.id);
      setSubtitleContent(result.subtitle.content);
      setNotice(`${format.toUpperCase()} subtitle generated.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not generate subtitles.');
    } finally { setBusy(false); }
  }

  async function createVideo() {
    if (!videoAudioId) {
      setError('Choose a final audio mix first.');
      return;
    }
    if (videoMode === 'elevenlabs' && !videoPrompt.trim()) {
      setError('Describe the video you want ElevenLabs to generate.');
      return;
    }
    if (videoMode === 'uploaded' && selectedVideoClipIds.length === 0) {
      setError('Upload and select at least one video clip.');
      return;
    }
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await request<{ video: Video }>(`/api/audio/${videoAudioId}/video`, {
        method: 'POST',
        body: JSON.stringify({
          mode: videoMode,
          title: videoTitle.trim() || 'Episode video',
          aspectRatio: videoAspectRatio,
          resolution: videoResolution,
          prompt: videoMode === 'elevenlabs' ? videoPrompt.trim() : undefined,
          clipIds: videoMode !== 'elevenlabs' ? selectedVideoClipIds : undefined,
          ghostStyle: videoMode === 'ghost' ? ghostStyle : undefined,
          subtitleId: videoSubtitleId || undefined,
        }),
      });
      setVideos((current) => [result.video, ...current.filter((video) => video.id !== result.video.id)]);
      setNotice(videoMode === 'elevenlabs'
        ? 'ElevenLabs is generating a visual clip; it will be combined with your audio when ready.'
        : videoMode === 'ghost'
          ? 'Ghost Editor is analyzing your footage and script with Claude, then rendering your reel.'
          : 'Video export started; the selected clips will be combined with your audio.');
      await refreshEpisode(episodeId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start video rendering.');
    } finally { setBusy(false); }
  }

  async function uploadVideoClips() {
    if (!episodeId || videoFiles.length === 0) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const added: VideoClip[] = [];
      for (const file of videoFiles) {
        if (file.size > 100 * 1024 * 1024) throw new Error(`${file.name} exceeds the 100 MB limit.`);
        if (!['video/mp4', 'video/quicktime', 'video/webm'].includes(file.type)) {
          throw new Error(`${file.name} must be MP4, QuickTime, or WebM.`);
        }
        const query = new URLSearchParams({ title: file.name });
        const response = await fetch(`${apiUrl}/api/episodes/${episodeId}/video-clips?${query}`, {
          method: 'POST',
          headers: { 'content-type': file.type },
          body: file,
        });
        const result = await response.json().catch(() => ({})) as { error?: { message?: string }; clip?: VideoClip };
        if (!response.ok) throw new Error(result.error?.message ?? `Upload failed (${response.status}).`);
        const clip = result.clip;
        if (!clip) throw new Error('The API did not return the uploaded video record.');
        added.push(clip);
        setVideoClips((current) => [clip, ...current.filter((item) => item.id !== clip.id)]);
        setSelectedVideoClipIds((current) => current.includes(clip.id) ? current : [...current, clip.id]);
      }
      setVideoFiles([]);
      setNotice(`${added.length} video clip(s) uploaded.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not upload video clips.');
    } finally { setBusy(false); }
  }

  function moveVideoClip(index: number, offset: number) {
    const next = [...selectedVideoClipIds];
    const target = index + offset;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setSelectedVideoClipIds(next);
  }

  function moveTimelineItem(index: number, offset: number) {
    const next = [...selectedAudioIds];
    const target = index + offset;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setSelectedAudioIds(next);
  }

  return (
    <main className="studio">
      <aside className="studio-sidebar">
        <a className="brand" href="#"><span className="brand-mark">s</span><span>sonora<span className="brand-dot">.</span></span></a>
        <div className="workspace-label">WORKSPACE</div>
        <label className="select-label">PROJECT</label>
        <select value={projectId} onChange={(event) => { setProjectId(event.target.value); setEpisodeId(''); setSelectedAudioIds([]); loadedScriptEpisode.current = ''; mappingLoadedEpisode.current = ''; }} aria-label="Select project">
          <option value="">Select a project</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        <div className="sidebar-create"><input aria-label="New project name" value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} placeholder="Project name" /><button className="sidebar-action" disabled={busy} onClick={createProject}>＋ New project</button></div>
        <label className="select-label">EPISODE</label>
        <select value={episodeId} onChange={(event) => setEpisodeId(event.target.value)} aria-label="Select episode" disabled={!projectId}>
          <option value="">Select an episode</option>
          {episodes.map((episode) => <option key={episode.id} value={episode.id}>{episode.title}</option>)}
        </select>
        <div className="sidebar-create"><input aria-label="New episode title" value={newEpisodeTitle} onChange={(event) => setNewEpisodeTitle(event.target.value)} placeholder="Episode title" /><button className="sidebar-action" disabled={!projectId || busy} onClick={createEpisode}>＋ New episode</button></div>
        <div className="sidebar-note">
          <span className={`api-led ${apiOnline ? 'connected' : ''}`} />
          <span><strong>Local studio</strong><small>{apiOnline ? 'API connected' : 'Connecting to API…'}</small></span>
        </div>
        <div className="sidebar-bottom">
          <div className="plan-card"><div className="plan-icon">✳</div><strong>Keep it local</strong><p>Project data and audio are stored in the local data folder.</p></div>
          <div className="profile"><span className="profile-avatar">BP</span><span><strong>Local workspace</strong><small>Single-user development</small></span></div>
        </div>
      </aside>

      <section className="studio-main">
        <header className="topbar"><div className="breadcrumbs"><span>Projects</span><span className="crumb-slash">/</span><strong>{episodes.find((episode) => episode.id === episodeId)?.title ?? 'New episode'}</strong></div><div className={`api-status ${apiOnline ? 'online' : ''}`}><span />{apiOnline ? 'API connected' : 'API offline'}</div></header>
        <div className="studio-content">
          <div className="page-heading">
            <div><div className="eyebrow"><span className="eyebrow-dot" /> PODCAST STUDIO</div><h1>{episodes.find((episode) => episode.id === episodeId)?.title ?? 'Your next episode'} <span className="wave">✳</span></h1><p>From conversation to finished audio, all in one place.</p></div>
            <div className="top-selects"><label>MODEL<select value={modelId} onChange={(event) => setModelId(event.target.value)}><option value="eleven_v3">Eleven v3</option><option value="eleven_v3_conversational">Eleven v3 Conversational</option><option value="eleven_multilingual_v2">Eleven Multilingual v2</option></select></label><label>LANGUAGE<input value={languageCode} onChange={(event) => setLanguageCode(event.target.value)} maxLength={16} /></label></div>
          </div>
          {!projects.length && <div className="empty-start"><strong>Welcome to your studio</strong><p>Create a project and episode to start turning a script into audio.</p><button className="primary-button" onClick={createProject}>＋ Create project</button></div>}
          {projects.length > 0 && !episodes.length && <div className="empty-start"><strong>Create your first episode</strong><p>Each episode contains a script, voice mappings, generated audio, and subtitles.</p><button className="primary-button" onClick={createEpisode}>＋ New episode</button></div>}
          {!!episodeId && <>
            <nav className="workflow-tabs" aria-label="Episode workflow">{tabs.map(([key, number, label]) => <button key={key} className={tab === key ? 'selected' : ''} onClick={() => setTab(key)}><span>{number}</span>{label}</button>)}</nav>
            {error && <div className="alert error-alert"><strong>Couldn&apos;t complete that action</strong><span>{error}</span><button onClick={() => setError('')}>×</button></div>}
            {notice && <div className="alert success-alert"><span>{notice}</span><button onClick={() => setNotice('')}>×</button></div>}

            {tab === 'script' && <section className="workspace-card">
              <div className="workspace-card-heading"><div><div className="section-kicker">STEP 01 · SCRIPT</div><h2>Start with your conversation</h2><p>Use one line per speaker turn. Audio tags such as [curious] are preserved.</p></div><span className="script-icon">⌘</span></div>
              <div className="editor-label-row"><label htmlFor="script">SCRIPT TEXT</label><span>Speaker: dialogue</span></div>
              <textarea id="script" value={script} onChange={(event) => { scriptDirty.current = true; setScript(event.target.value); }} placeholder={'Maya: Hello there.\\nLeo: It is good to be here.'} />
              <div className="editor-footer"><div className="script-metrics"><span><i className="metric-dot" /> {script.length.toLocaleString()} characters</span><span>{wordCount} words</span>{scriptRecord && <span>Saved v{scriptRecord.version}</span>}</div><button className="analyze-button" disabled={busy || !script.trim()} onClick={saveScript}>{busy ? 'Saving…' : scriptRecord ? 'Save & parse' : 'Save & find speakers'} <span>→</span></button></div>
              {!!warnings.length && <div className="warning-list">{warnings.map((warning, index) => <p key={`${warning.code}-${index}`}>Line {warning.line}: {warning.message}</p>)}</div>}
              {!!lines.length && <div className="parsed-lines"><strong>{lines.length} parsed dialogue turns</strong>{lines.slice(0, 5).map((line) => <div key={line.sequence}><b>{line.speaker}</b><span>{line.text}</span></div>)}{lines.length > 5 && <small>and {lines.length - 5} more…</small>}</div>}
              <div className="step-footer"><span>Next: assign a voice to every speaker.</span><button className="text-button" onClick={() => setTab('voices')} disabled={!characters.length}>Continue to voices →</button></div>
            </section>}

            {tab === 'voices' && <section className="workspace-card">
              <div className="workspace-card-heading"><div><div className="section-kicker">STEP 02 · VOICE CAST</div><h2>Give every character a voice</h2><p>Paste a voice ID or choose one from your ElevenLabs account.</p></div><span className="script-icon">♫</span></div>
              {!scriptRecord && <div className="inline-empty">Save a script first to detect speakers. <button className="text-button" onClick={() => setTab('script')}>Go to script →</button></div>}
              {characters.map((character) => <div className="voice-row" key={character.key}><span className="voice-avatar">{character.name.slice(0, 1).toUpperCase()}</span><div className="voice-person"><strong>{character.name}</strong><small>{character.key}</small></div><select value={voiceIds[character.key] ?? ''} onChange={(event) => setVoiceIds((current) => ({ ...current, [character.key]: event.target.value }))}><option value="">Choose voice (or enter ID)</option>{voices.map((voice) => <option key={voice.voiceId} value={voice.voiceId}>{voice.name} · {voice.category ?? 'voice'}</option>)}</select><input aria-label={`${character.name} voice ID`} value={voiceIds[character.key] ?? ''} onChange={(event) => setVoiceIds((current) => ({ ...current, [character.key]: event.target.value }))} placeholder="ElevenLabs voice ID" />{voices.find((voice) => voice.voiceId === voiceIds[character.key])?.previewUrl && <audio className="voice-preview" controls preload="none" src={voices.find((voice) => voice.voiceId === voiceIds[character.key])?.previewUrl} />}</div>)}
              {voiceError && <p className="muted-notice">{voiceError} You can still enter voice IDs manually. <button className="text-button" onClick={loadVoices}>Retry loading voices</button></p>}
              <div className="editor-footer"><span className="script-metrics">{mappedCount} of {characters.length} speakers mapped</span><button className="analyze-button" disabled={busy || mappedCount !== characters.length || !characters.length} onClick={saveVoiceMappings}>{busy ? 'Saving…' : 'Save voice mappings'} <span>→</span></button></div>
              <div className="step-footer"><span>Up to 10 distinct voices per chunk.</span><button className="text-button" onClick={() => setTab('generation')} disabled={mappedCount !== characters.length}>Continue to generation →</button></div>
            </section>}

            {tab === 'generation' && <section className="workspace-card">
              <div className="workspace-card-heading"><div><div className="section-kicker">STEP 03 · GENERATION</div><h2>Generate your dialogue</h2><p>Your script is split into requests of at most 2,000 characters, then processed in the background.</p></div><span className="script-icon">◉</span></div>
              <div className="generation-summary"><div><small>SCRIPT</small><strong>{scriptRecord ? `Version ${scriptRecord.version}` : 'Not saved'}</strong></div><div><small>SPEAKERS</small><strong>{mappedCount} mapped</strong></div><div><small>CHUNKS</small><strong>{Math.max(1, Math.ceil(script.length / 2000))} estimated</strong></div><div><small>MODEL</small><strong>{modelId}</strong></div></div>
              <div className="advanced-options"><label>TEXT NORMALIZATION<select value={normalization} onChange={(event) => setNormalization(event.target.value as 'auto' | 'on' | 'off')}><option value="auto">Auto</option><option value="on">On</option><option value="off">Off</option></select></label><label>SEED (OPTIONAL)<input type="number" value={seed} onChange={(event) => setSeed(event.target.value)} placeholder="Random" /></label><button className="text-button" onClick={previewPayload} disabled={busy || !scriptRecord}>Preview payload</button></div>
              {payloadPreview && <div className="payload-panel"><div className="payload-tabs"><button className={payloadView === 'visual' ? 'active' : ''} onClick={() => setPayloadView('visual')}>Summary</button><button className={payloadView === 'json' ? 'active' : ''} onClick={() => setPayloadView('json')}>JSON</button></div>{payloadView === 'json' ? <pre>{payloadPreview}</pre> : <p>{lines.length} dialogue turns · {characters.length} speakers · 2,000 character limit per request. Review the JSON view before generating.</p>}</div>}
              <button className="primary-button large-button" disabled={busy || !scriptRecord || mappedCount !== characters.length || !characters.length} onClick={createAndStartBatch}>{busy ? 'Queueing…' : '▶  Generate audio'}</button>
              {batches.map((batch) => <div className="batch-card" key={batch.id}><div className="batch-top"><strong>{batch.label}</strong><span className={`batch-status ${batch.status.toLowerCase()}`}>{batch.status}</span></div><div className="batch-progress"><i style={{ width: `${batch.totalChunks ? batch.completedChunks / batch.totalChunks * 100 : 0}%` }} /></div><small>{batch.completedChunks}/{batch.totalChunks} complete · {batch.failedChunks} failed</small>{chunks.filter((chunk) => chunk.status === 'FAILED').map((chunk) => <p className="chunk-failure" key={chunk.id}>Chunk {chunk.chunkIndex}: {chunk.errorMessage}</p>)}{batch.failedChunks > 0 && <button className="text-button" disabled={busy} onClick={() => retryBatch(batch)}>Retry failed chunks →</button>}</div>)}
            </section>}

            {tab === 'library' && <section className="workspace-card">
              <div className="workspace-card-heading"><div><div className="section-kicker">STEP 04 · AUDIO LIBRARY</div><h2>Your generated audio</h2><p>Preview, download, or remove audio clips from this episode.</p></div><span className="script-icon">♫</span></div>
              {!audios.length && <div className="inline-empty">No audio yet. <button className="text-button" onClick={() => setTab('generation')}>Generate your first chunks →</button></div>}
              <div className="audio-list">{audios.map((audio) => <div className="audio-row" key={audio.id}><input type="checkbox" checked={selectedAudioIds.includes(audio.id)} disabled={audio.kind !== 'chunk'} onChange={(event) => setSelectedAudioIds((current) => event.target.checked ? [...current, audio.id] : current.filter((id) => id !== audio.id))} /><div className="audio-kind">{audio.kind === 'final' ? 'MP3' : '♪'}</div><div className="audio-title"><strong>{audio.label}</strong><small>{audio.kind} · {(audio.sizeBytes / 1024).toFixed(0)} KB {audio.durationSeconds ? `· ${audio.durationSeconds.toFixed(1)} sec` : ''}</small></div><audio controls preload="none" src={`${apiUrl}/api/audio/${audio.id}/stream`} /><a className="download-link" href={`${apiUrl}/api/audio/${audio.id}/download`} download>↓</a><button className="text-button delete-audio" onClick={async () => { try { await request(`/api/audio/${audio.id}`, { method: 'DELETE' }); setAudios((current) => current.filter((item) => item.id !== audio.id)); setSelectedAudioIds((current) => current.filter((id) => id !== audio.id)); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not remove audio.'); } }}>Remove</button></div>)}</div>
              <div className="step-footer"><span>Selected clips can be arranged in your composer.</span><button className="text-button" onClick={() => setTab('composer')}>Open composer →</button></div>
            </section>}

            {tab === 'composer' && <section className="workspace-card">
              <div className="workspace-card-heading"><div><div className="section-kicker">STEP 05 · COMPOSER</div><h2>Arrange your episode</h2><p>Choose clips in the library, then change their order before merging.</p></div><span className="script-icon">▤</span></div>
              <div className="composer-toolbar"><label>COMPOSITION NAME<input value={compositionName} onChange={(event) => setCompositionName(event.target.value)} /></label><span>{selectedAudioIds.length} clip(s) selected</span></div>
              <div className="timeline-list">{selectedAudioIds.map((id, index) => <div className="timeline-row" key={`${id}-${index}`} draggable onDragStart={() => setDraggedIndex(index)} onDragOver={(event) => event.preventDefault()} onDrop={() => { if (draggedIndex !== null) { const next = [...selectedAudioIds]; const [moved] = next.splice(draggedIndex, 1); next.splice(index, 0, moved); setSelectedAudioIds(next); setDraggedIndex(null); } }}><span className="timeline-index">⠿ {String(index + 1).padStart(2, '0')}</span><strong>{audios.find((audio) => audio.id === id)?.label ?? 'Audio clip'}</strong><label className="timeline-gap">Gap <input type="number" min="0" max="10000" value={timelineGaps[id] ?? 300} onChange={(event) => setTimelineGaps((current) => ({ ...current, [id]: Number(event.target.value) }))} />ms</label><button aria-label="Move clip up" disabled={index === 0} onClick={() => moveTimelineItem(index, -1)}>↑</button><button aria-label="Move clip down" disabled={index === selectedAudioIds.length - 1} onClick={() => moveTimelineItem(index, 1)}>↓</button><button aria-label="Remove clip" onClick={() => setSelectedAudioIds((current) => current.filter((item) => item !== id))}>×</button></div>)}</div>
              <p className="muted-notice">Need more clips? Select them from the <button className="text-button" onClick={() => setTab('library')}>audio library</button>. FFmpeg and FFprobe must be on PATH to merge.</p>
              <button className="analyze-button" disabled={busy || !selectedAudioIds.length} onClick={createComposition}>{busy ? 'Starting merge…' : 'Merge to final MP3'} <span>→</span></button>
              {compositions.map((composition) => <div className="batch-card" key={composition.id}><div className="batch-top"><strong>{composition.name}</strong><span className={`batch-status ${composition.status.toLowerCase()}`}>{composition.status}</span></div>{composition.errorMessage && <p className="chunk-failure">{composition.errorMessage}</p>}{composition.outputAudioId && <a className="text-button" href={`${apiUrl}/api/audio/${composition.outputAudioId}/download`}>Download final MP3 ↓</a>}</div>)}
            </section>}

            {tab === 'transcript' && <section className="workspace-card">
              <div className="workspace-card-heading"><div><div className="section-kicker">STEP 06 · TRANSCRIPT & EXPORT</div><h2>Transcribe and export subtitles</h2><p>Transcribe a final mix with ElevenLabs, then create and edit SRT or WebVTT subtitles.</p></div><span className="script-icon">≋</span></div>
              <label className="field-label">FINAL AUDIO<select value={selectedAudioId} onChange={(event) => setSelectedAudioId(event.target.value)}><option value="">Choose audio</option>{audios.filter((audio) => audio.kind === 'final').map((audio) => <option key={audio.id} value={audio.id}>{audio.label}</option>)}</select></label>
              <button className="analyze-button" disabled={busy || !selectedAudioId} onClick={transcribeAudio}>{busy ? 'Transcribing…' : 'Transcribe selected audio'} <span>→</span></button>
              {transcriptions.map((transcription) => <div className="transcript-card" key={transcription.id}><div className="batch-top"><strong>Transcription</strong><span className={`batch-status ${transcription.status.toLowerCase()}`}>{transcription.status}</span></div><p className="transcript-text">{transcription.text}</p><textarea aria-label="Edit generated subtitle" value={subtitleContent} onChange={(event) => setSubtitleContent(event.target.value)} placeholder="Generate SRT or VTT to edit subtitle text" /><div className="editor-footer"><button className="text-button" onClick={() => generateSubtitles(transcription, 'srt')} disabled={busy || transcription.status !== 'COMPLETED'}>Generate SRT</button><button className="text-button" onClick={() => generateSubtitles(transcription, 'vtt')} disabled={busy || transcription.status !== 'COMPLETED'}>Generate VTT</button>{subtitleId && <><button className="text-button" onClick={async () => { try { const saved = await request<{ subtitle: { id: string; content: string } }>(`/api/transcriptions/${transcription.id}/generate-srt`, { method: 'POST', body: JSON.stringify({ format: subtitleContent.startsWith('WEBVTT') ? 'vtt' : 'srt', content: subtitleContent }) }); setSubtitleId(saved.subtitle.id); setNotice('Subtitle changes saved.'); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save subtitle.'); } }}>Save edits</button><a className="text-button" href={`${apiUrl}/api/subtitles/${subtitleId}/download`}>Download ↓</a></>}</div></div>)}
              {!transcriptions.length && <p className="muted-notice">Speech-to-text requires a configured ElevenLabs API key. Subtitles use up to 2 lines of 42 characters each.</p>}
            </section>}

            {tab === 'video' && <section className="workspace-card">
              <div className="workspace-card-heading"><div><div className="section-kicker">STEP 07 · VIDEO EXPORT</div><h2>Build your episode video</h2><p>Choose an ElevenLabs-generated visual or assemble your own clips with the final voice track.</p></div><span className="script-icon">▶</span></div>
              <label className="field-label">FINAL AUDIO<select value={videoAudioId} onChange={(event) => setVideoAudioId(event.target.value)}><option value="">Choose final audio</option>{audios.filter((audio) => audio.kind === 'final').map((audio) => <option key={audio.id} value={audio.id}>{audio.label}</option>)}</select></label>
              <label className="field-label">VIDEO TITLE<input value={videoTitle} onChange={(event) => setVideoTitle(event.target.value)} maxLength={120} /></label>
              <label className="field-label">ASPECT RATIO<select value={videoAspectRatio} onChange={(event) => setVideoAspectRatio(event.target.value as '16:9' | '9:16' | '1:1')}><option value="16:9">16:9 · Landscape</option><option value="9:16">9:16 · Portrait</option><option value="1:1">1:1 · Square</option></select></label>
              <label className="field-label">OUTPUT RESOLUTION<select value={videoResolution} onChange={(event) => setVideoResolution(Number(event.target.value) as 720 | 1080)}><option value={720}>720p</option><option value={1080}>1080p</option></select></label>
              <div className="video-mode-switch" role="group" aria-label="Video source">
                <button className={videoMode === 'elevenlabs' ? 'selected' : ''} onClick={() => setVideoMode('elevenlabs')}>Generate with ElevenLabs</button>
                <button className={videoMode === 'uploaded' ? 'selected' : ''} onClick={() => setVideoMode('uploaded')}>Use my video clips</button>
                <button className={videoMode === 'ghost' ? 'selected' : ''} onClick={() => { setVideoMode('ghost'); setVideoAspectRatio('9:16'); setVideoResolution(1080); void loadGhostStatus(); }}>Ghost Editor · AI reel</button>
              </div>
              {videoMode === 'elevenlabs' ? <>
                <label className="field-label">VISUAL PROMPT<textarea value={videoPrompt} onChange={(event) => setVideoPrompt(event.target.value)} maxLength={1000} placeholder="Describe the visual style and scene" /></label>
                <p className="muted-notice">Uses the ElevenLabs Video Generation API (Seedance v2 Fast, 720p). A 5-second visual is looped to match your audio. Requires Image &amp; Video Generation access and a paid plan; the generated clip is charged by ElevenLabs.</p>
              </> : <>
                {videoMode === 'ghost' && <>
                  <label className="field-label">GHOST EDITING STYLE<select value={ghostStyle} onChange={(event) => setGhostStyle(event.target.value)}>{(ghostStatus.styles.length ? ghostStatus.styles : ['clean', 'editorial', 'meme', 'cinematic', 'launch', 'kinetic', 'pop']).map((style) => <option key={style} value={style}>{style[0].toUpperCase() + style.slice(1)}</option>)}</select></label>
                  {!ghostStatus.installed ? <p className="muted-notice">Claude Code CLI is not available to the API. Install it on Windows and set CLAUDE_CODE_PATH in .env.</p> : !ghostStatus.authenticated ? <p className="muted-notice">Claude Code is installed but needs sign-in. Run <code>claude auth login</code> in a terminal, then reload this page.</p> : <p className="muted-notice">Claude inspects contact sheets and your script to plan cuts. Sampled video frames and script text are sent to Claude. Ghost Editor presets style captions; if word timings are missing, ElevenLabs speech-to-text runs first.</p>}
                </>}
                <label className="field-label">UPLOAD VIDEO CLIPS<input type="file" accept="video/mp4,video/quicktime,video/webm" multiple onChange={(event) => { setVideoFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ''; }} /></label>
                <p className="muted-notice">MP4, QuickTime, or WebM · up to 100 MB each and 15 minutes each. Clips are normalized to 720p. Short timelines loop; the final export is trimmed to the selected audio.</p>
                <button className="text-button" disabled={busy || !videoFiles.length} onClick={uploadVideoClips}>{busy ? 'Uploading…' : `Upload ${videoFiles.length || ''} selected clip(s)`} ↑</button>
                <div className="video-clip-list">{videoClips.map((clip) => <label className="video-clip-row" key={clip.id}><input type="checkbox" checked={selectedVideoClipIds.includes(clip.id)} onChange={(event) => setSelectedVideoClipIds((current) => event.target.checked ? [...current, clip.id] : current.filter((id) => id !== clip.id))} /><span><strong>{clip.title}</strong><small>{clip.durationSeconds.toFixed(1)} sec · {(clip.sizeBytes / 1024 / 1024).toFixed(1)} MB</small></span></label>)}</div>
                {!!selectedVideoClipIds.length && <div className="timeline-list">{selectedVideoClipIds.map((clipId, index) => <div className="timeline-row" key={clipId}><span className="timeline-index">{String(index + 1).padStart(2, '0')}</span><strong>{videoClips.find((clip) => clip.id === clipId)?.title ?? 'Video clip'}</strong><button aria-label="Move video clip up" disabled={index === 0} onClick={() => moveVideoClip(index, -1)}>↑</button><button aria-label="Move video clip down" disabled={index === selectedVideoClipIds.length - 1} onClick={() => moveVideoClip(index, 1)}>↓</button><button aria-label="Remove video clip" onClick={() => setSelectedVideoClipIds((current) => current.filter((id) => id !== clipId))}>×</button></div>)}</div>}
              </>}
              <label className="field-label">SUBTITLES<select value={videoSubtitleId} onChange={(event) => setVideoSubtitleId(event.target.value)}><option value="">No subtitles</option>{subtitles.filter((subtitle) => ['srt', 'vtt'].includes(subtitle.format) && transcriptions.some((transcription) => transcription.id === subtitle.transcriptionId && transcription.audioId === videoAudioId && transcription.status === 'COMPLETED')).map((subtitle) => <option key={subtitle.id} value={subtitle.id}>{subtitle.format.toUpperCase()} · {new Date(subtitle.createdAt).toLocaleString()}</option>)}</select></label>
              <p className="muted-notice">SRT/VTT generated in Transcript &amp; Export for this final audio is selected automatically. Captions are burned into the video and included as a selectable subtitle track.</p>
              {!audios.some((audio) => audio.kind === 'final') && <div className="inline-empty">Create a final mix in Composer before exporting video. <button className="text-button" onClick={() => setTab('composer')}>Open composer →</button></div>}
              <button className="analyze-button" disabled={busy || !videoAudioId || (videoMode !== 'elevenlabs' && !selectedVideoClipIds.length) || (videoMode === 'elevenlabs' && !videoPrompt.trim())} onClick={createVideo}>{busy ? 'Starting…' : videoMode === 'ghost' ? 'Auto-edit reel with Claude' : 'Create MP4 video'} <span>→</span></button>
              {!!videos.length && <div className="video-list">{videos.map((video, index) => <div className="video-row" key={video.id}><div className="video-kind">{String(videos.length - index).padStart(2, '0')}</div><div className="audio-title"><strong>{video.title}</strong><small>{video.sourceMode === 'elevenlabs' ? 'ElevenLabs visual' : video.sourceMode === 'ghost' ? 'Ghost Editor reel' : video.sourceMode === 'uploaded' ? 'Uploaded clips' : 'Cover image'} · {video.status === 'READY' ? `${video.aspectRatio ?? '16:9'} · ${video.resolution ?? 720}p · ${(video.sizeBytes / 1024 / 1024).toFixed(1)} MB` : video.status.toLowerCase()}</small>{video.errorMessage && <small className="chunk-failure">{video.errorMessage}</small>}</div><span className={`batch-status ${video.status.toLowerCase()}`}>{video.status}</span>{video.status === 'READY' && <><button className="video-preview-toggle" onClick={() => setPreviewVideoId((current) => current === video.id ? '' : video.id)}>{previewVideoId === video.id ? 'Hide preview' : '▶ Preview'}</button><a className="download-link" href={`${apiUrl}/api/videos/${video.id}/download`} download>↓</a>{previewVideoId === video.id && <video className="video-preview" controls preload="metadata" src={`${apiUrl}/api/videos/${video.id}/download`} />}</>}</div>)}</div>}
            </section>}
          </>}
          <footer className="page-footer"><span>Made for stories worth hearing.</span><span>SONORA STUDIO · LOCAL MVP</span></footer>
        </div>
      </section>
    </main>
  );
}
