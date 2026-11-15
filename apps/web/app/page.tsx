'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

type Project = { id: string; name: string; createdAt?: string; updatedAt?: string };
type Episode = { id: string; projectId: string; title: string; languageCode: string; defaultModelId: string; status: string; updatedAt?: string; createdAt?: string };
type Character = { key: string; name: string };
type ScriptLine = { sequence: number; speaker: string; text: string };
type Warning = { code: string; line: number; message: string };
type Script = { id: string; rawText: string; version: number };
type Audio = { id: string; kind: 'chunk' | 'final'; label: string; sizeBytes: number; durationSeconds: number | null; createdAt?: string };
type Chunk = { id: string; batchId: string; chunkIndex: number; status: string; errorMessage: string | null; audioId: string | null };
type Batch = { id: string; label: string; status: string; completedChunks: number; failedChunks: number; totalChunks: number };
type Composition = { id: string; name: string; status: string; outputAudioId: string | null; errorMessage: string | null };
type Transcription = { id: string; audioId: string; text: string; status: string; segments?: Array<{start:number;end:number;text:string}> };
type Video = { id: string; audioId: string; title: string; status: string; sourceMode?: 'elevenlabs' | 'uploaded' | 'cover' | 'ghost'; ghostStyle?: string | null; aspectRatio?: '16:9' | '9:16' | '1:1'; resolution?: 720 | 1080; sizeBytes: number; errorMessage: string | null; createdAt: string; prompt?: string | null; clipIds?: string[]; subtitleId?: string | null; voiceVolume?: number; musicTracks?: MusicPick[]; editEvents?: VideoEditEvent[]; subtitleStyle?: { animation?: CaptionAnimation; fontFamily?: string; fontSize?: number; fontWeight?: 'regular' | 'medium' | 'bold' | 'extra-bold'; textColor?: string; highlightColor?: string; preset?: VideoPreset; intensity?: EditIntensity } };
type VideoClip = { id: string; title: string; mimeType: string; sizeBytes: number; durationSeconds: number; createdAt: string };
type MusicAsset = { id: string; name: string; mimeType: string; format: 'mp3'|'mp4'; sizeBytes: number; durationSeconds: number; status: string; createdAt: string };
type MusicPick = { musicId: string; volume: number; startSeconds: number; endSeconds: number | null; outputStartSeconds: number; fadeInSeconds: number; fadeOutSeconds: number };
type CaptionAnimation = 'karaoke' | 'word' | 'edit' | 'fade' | 'fade-out' | 'pop' | 'pop-out' | 'bounce' | 'typewriter' | 'word-reveal' | 'scale-punch' | 'slide' | 'shake' | 'elastic' | 'glitch' | 'rotation' | 'blur' | 'wave' | 'tracking' | 'stagger' | 'smooth';
type VideoPreset = 'tiktok' | 'cinematic' | 'meme' | 'minimal' | 'storytelling' | 'podcast' | 'energetic';
type EditIntensity = 'subtle' | 'balanced' | 'creative';
type VideoEditTrack = 'typography' | 'sticker' | 'visual-effect' | 'sound-effect';
type VideoEditEvent = { id: string; episodeVideoId?: string; createdAt?: string; track: VideoEditTrack; startSeconds: number; endSeconds: number; text: string; animation: string; position: 'top' | 'center' | 'bottom'; scale: number; opacity: number; volume: number; enabled: boolean; orderIndex: number; musicAssetId?: string | null; effect?: string | null };
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
  music: MusicAsset[];
};

function wasCreatedToday(createdAt?: string) {
  if (!createdAt) return false;
  const created = new Date(createdAt);
  const today = new Date();
  return created.getFullYear() === today.getFullYear()
    && created.getMonth() === today.getMonth()
    && created.getDate() === today.getDate();
}

function createSmartEditPlan(segments: Array<{ start: number; end: number; text: string }>): VideoEditEvent[] {
  const plan: VideoEditEvent[] = [];
  const salient = /^(cuc|ky|sieu|tien|loi|nho|gon|dac|biet|chot|ngay|mua|gio|hang|wow|omg|really|incredible|wait|buy|now)$/;
  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text || segment.end <= segment.start) continue;
    const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/[^a-z0-9]/g, '');
    const hasQuestion = /[?？]/.test(text);
    const hasExcitement = /[!！]/.test(text);
    const isSalient = salient.test(normalized) || (text.length > 2 && text === text.toLocaleUpperCase() && /[\p{L}]/u.test(text));
    if (!hasQuestion && !hasExcitement && !isSalient) continue;
    const endSeconds = Math.max(segment.end + 0.65, segment.start + 0.4);
    const words = text.replace(/[!?！？]+/g, '').trim();
    if (words) plan.push({ id: crypto.randomUUID(), track: 'typography', startSeconds: segment.start, endSeconds, text: words.toLocaleUpperCase(), animation: hasExcitement ? 'bounce' : 'pop', position: 'center', scale: hasExcitement ? 1.55 : 1.35, opacity: 1, volume: 0.2, enabled: true, orderIndex: plan.length });
    if (hasQuestion || hasExcitement) plan.push({ id: crypto.randomUUID(), track: 'sticker', startSeconds: segment.start, endSeconds, text: hasQuestion ? '❓' : '✨', animation: 'bounce', position: hasQuestion ? 'top' : 'center', scale: 1.1, opacity: 1, volume: 0.2, enabled: true, orderIndex: plan.length });
    if (plan.length >= 80) break;
  }
  return plan.slice(0,80);
}

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
  const [allEpisodes, setAllEpisodes] = useState<Episode[]>([]);
  const [page, setPage] = useState<'home' | 'projects' | 'history' | 'studio'>('home');
  const [historyItems, setHistoryItems] = useState<Array<{ episode: Episode; project: Project; audios: Audio[]; videos: Video[] }>>([]);
  const [projectSearch, setProjectSearch] = useState('');
  const [projectFilter, setProjectFilter] = useState<'all' | 'today' | 'with-episodes' | 'empty'>('all');
  const [projectSort, setProjectSort] = useState<'newest' | 'oldest' | 'name-asc' | 'name-desc'>('newest');
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
  const loadedVideoDraftId = useRef('');
  const transcriptAudioCursor = useRef<{ episodeId: string; latestFinalAudioId: string }>({ episodeId: '', latestFinalAudioId: '' });
  const [scriptRecord, setScriptRecord] = useState<Script | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [lines, setLines] = useState<ScriptLine[]>([]);
  const [warnings, setWarnings] = useState<Warning[]>([]);
  const [voiceIds, setVoiceIds] = useState<Record<string, string>>({});
  const [voiceCount, setVoiceCount] = useState<1 | 2>(1);
  const [voiceSlots, setVoiceSlots] = useState<[string, string]>(['', '']);
  const [voiceAssignments, setVoiceAssignments] = useState<Record<string, 0 | 1>>({});
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
  const [videoDraftId, setVideoDraftId] = useState('');
  const [videoMode, setVideoMode] = useState<'elevenlabs' | 'uploaded' | 'ghost'>('elevenlabs');
  const [ghostStyle, setGhostStyle] = useState('clean');
  const [ghostStatus, setGhostStatus] = useState<{ installed: boolean; authenticated: boolean; styles: string[] }>({ installed: false, authenticated: false, styles: [] });
  const [videoAspectRatio, setVideoAspectRatio] = useState<'16:9' | '9:16' | '1:1'>('16:9');
  const [videoResolution, setVideoResolution] = useState<720 | 1080>(720);
  const [videoPrompt, setVideoPrompt] = useState('');
  const [videoFiles, setVideoFiles] = useState<File[]>([]);
  const [selectedVideoClipIds, setSelectedVideoClipIds] = useState<string[]>([]);
  const [videoEditEvents, setVideoEditEvents] = useState<VideoEditEvent[]>([]);
  const [videoSubtitleId, setVideoSubtitleId] = useState('');
  const [captionTextColor, setCaptionTextColor] = useState('#ffffff');
  const [captionHighlightColor, setCaptionHighlightColor] = useState('#ffe45e');
  const [captionAnimation, setCaptionAnimation] = useState<CaptionAnimation>('karaoke');
  const [captionFontFamily, setCaptionFontFamily] = useState('Arial');
  const [captionFontSize, setCaptionFontSize] = useState(52);
  const [captionFontWeight, setCaptionFontWeight] = useState<'regular' | 'medium' | 'bold' | 'extra-bold'>('bold');
  const [videoPreset, setVideoPreset] = useState<VideoPreset>('podcast');
  const [editIntensity, setEditIntensity] = useState<EditIntensity>('balanced');
  const [musicAssets, setMusicAssets] = useState<MusicAsset[]>([]);
  const [musicFiles, setMusicFiles] = useState<File[]>([]);
  const [selectedMusic, setSelectedMusic] = useState<MusicPick[]>([]);
  const [voiceVolume, setVoiceVolume] = useState(1);
  const [musicUploadProgress, setMusicUploadProgress] = useState('');
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

  const refreshDashboard = useCallback(async () => {
    const { projects: items } = await request<{ projects: Project[] }>('/api/projects');
    const rows = await Promise.all(items.map(async (project) => {
      const { episodes: projectEpisodes } = await request<{ episodes: Episode[] }>(`/api/projects/${project.id}/episodes`);
      return projectEpisodes.map((episode) => ({ episode, project }));
    }));
    const flat = rows.flat();
    setAllEpisodes(flat.map(({ episode }) => episode));
    const history = await Promise.all(flat.map(async ({ episode, project }) => {
      const data = await request<EpisodeData & { episode: Episode }>(`/api/episodes/${episode.id}`);
      return { episode, project, audios: data.audios, videos: data.videos };
    }));
    setHistoryItems(history);
  }, []);

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
    setMusicAssets(result.music ?? []);
    setLanguageCode(result.episode.languageCode);
    setModelId(result.episode.defaultModelId);
    const latestFinalAudio = result.audios.filter((audio) => audio.kind === 'final')
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0];
    const latestFinalAudioId = latestFinalAudio?.id ?? '';
    const transcriptCursor = transcriptAudioCursor.current;
    if (transcriptCursor.episodeId !== id || transcriptCursor.latestFinalAudioId !== latestFinalAudioId) {
      setSelectedAudioId(latestFinalAudioId);
      transcriptAudioCursor.current = { episodeId: id, latestFinalAudioId };
    } else {
      setSelectedAudioId((current) => result.audios.some((audio) => audio.id === current && audio.kind === 'final') ? current : latestFinalAudioId);
    }
    setVideoAudioId((current) => result.audios.some((audio) => audio.id === current && audio.kind === 'final')
      ? current
      : result.audios.find((audio) => audio.kind === 'final')?.id ?? '');
    if (videoTitleEpisode.current !== id) {
      videoTitleEpisode.current = id;
      loadedVideoDraftId.current = '';
      setVideoTitle(`${result.episode.title} video`);
      setVideoPrompt(`${result.episode.title}, cinematic podcast visuals, atmospheric landscape, gentle camera movement`);
      setVideoFiles([]);
      setSelectedVideoClipIds([]);
      setVideoSubtitleId('');
      setVideoDraftId('');
      setVideoEditEvents([]);
    }
    const draft = result.videos.find((video) => video.status === 'DRAFT');
    if (draft && loadedVideoDraftId.current !== draft.id) {
      loadedVideoDraftId.current = draft.id;
      setVideoDraftId(draft.id);
      setVideoAudioId(draft.audioId);
      setVideoTitle(draft.title);
      setVideoMode(draft.sourceMode === 'ghost' ? 'ghost' : draft.sourceMode === 'uploaded' ? 'uploaded' : 'elevenlabs');
      setVideoAspectRatio(draft.aspectRatio ?? '16:9');
      setVideoResolution(draft.resolution ?? 720);
      setVideoPrompt(draft.prompt ?? '');
      setSelectedVideoClipIds(draft.clipIds ?? []);
      setVideoSubtitleId(draft.subtitleId ?? '');
      setSelectedMusic(draft.musicTracks ?? []);
      setVoiceVolume(draft.voiceVolume ?? 1);
      setCaptionAnimation(draft.subtitleStyle?.animation ?? 'karaoke');
      setCaptionFontFamily(draft.subtitleStyle?.fontFamily ?? 'Arial');
      setCaptionFontSize(draft.subtitleStyle?.fontSize ?? 52);
      setCaptionFontWeight(draft.subtitleStyle?.fontWeight ?? 'bold');
      setVideoPreset(draft.subtitleStyle?.preset ?? 'podcast');
      setEditIntensity(draft.subtitleStyle?.intensity ?? 'balanced');
      setCaptionTextColor(draft.subtitleStyle?.textColor ?? '#ffffff');
      setCaptionHighlightColor(draft.subtitleStyle?.highlightColor ?? '#ffe45e');
      setVideoEditEvents(draft.editEvents ?? []);
    } else if (!draft && loadedVideoDraftId.current) {
      loadedVideoDraftId.current = '';
      setVideoDraftId('');
    }
    const charactersById = new Map(result.characters.map((character) => [character.id, character.key]));
    if (mappingLoadedEpisode.current !== id) {
      const loadedVoiceIds = Object.fromEntries(result.voiceMappings.flatMap((mapping) => {
        const key = charactersById.get(mapping.characterId);
        return key ? [[key, mapping.voiceId] as const] : [];
      }));
      const uniqueVoiceIds = [...new Set(Object.values(loadedVoiceIds))];
      setVoiceIds(loadedVoiceIds);
      setVoiceCount(uniqueVoiceIds.length > 1 ? 2 : 1);
      setVoiceSlots([uniqueVoiceIds[0] ?? '', uniqueVoiceIds[1] ?? '']);
      setVoiceAssignments(Object.fromEntries(Object.entries(loadedVoiceIds).map(([key, voiceId]) => [key, uniqueVoiceIds.indexOf(voiceId) === 1 ? 1 : 0])));
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

  useEffect(() => { refreshDashboard().catch(() => undefined); }, [refreshDashboard, projects.length]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const target = new URLSearchParams(window.location.search).get('episode');
    if (!target) return;
    const found = allEpisodes.find((episode) => episode.id === target);
    if (found) { setProjectId(found.projectId); setEpisodeId(found.id); setPage('studio'); }
  }, [allEpisodes]);

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
  const voiceReady = mappedCount === characters.length && characters.length > 0
    && (voiceCount === 1 ? !!voiceSlots[0] : !!voiceSlots[0] && !!voiceSlots[1] && voiceSlots[0] !== voiceSlots[1]);
  const wordCount = script.trim() ? script.trim().split(/\s+/).length : 0;
  const activeBatch = batches[0];
  const visibleProjects = useMemo(() => projects
    .filter((project) => project.name.toLocaleLowerCase().includes(projectSearch.trim().toLocaleLowerCase()))
    .filter((project) => {
      const count = allEpisodes.filter((episode) => episode.projectId === project.id).length;
      if (projectFilter === 'today') return wasCreatedToday(project.createdAt);
      if (projectFilter === 'with-episodes') return count > 0;
      if (projectFilter === 'empty') return count === 0;
      return true;
    })
    .sort((a, b) => {
      if (projectSort === 'name-asc') return a.name.localeCompare(b.name);
      if (projectSort === 'name-desc') return b.name.localeCompare(a.name);
      const diff = new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime();
      return projectSort === 'newest' ? -diff : diff;
    }), [projects, allEpisodes, projectSearch, projectFilter, projectSort]);

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

  function selectVoiceCount(count: 1 | 2) {
    if (count === 2 && characters.length < 2) return;
    const firstVoice = voiceSlots[0] || Object.values(voiceIds)[0] || voices[0]?.voiceId || '';
    const secondVoice = voiceSlots[1] || voices.find((voice) => voice.voiceId !== firstVoice)?.voiceId || '';
    const nextSlots: [string, string] = [firstVoice, secondVoice];
    setVoiceCount(count);
    setVoiceSlots(nextSlots);
    const nextAssignments = Object.fromEntries(characters.map((character, index) => [
      character.key,
      count === 1 ? 0 : (voiceAssignments[character.key] ?? (index % 2)) as 0 | 1,
    ])) as Record<string, 0 | 1>;
    setVoiceAssignments(nextAssignments);
    setVoiceIds(Object.fromEntries(characters.map((character) => [
      character.key,
      count === 1 ? firstVoice : nextSlots[nextAssignments[character.key]],
    ])));
  }

  function updateVoiceSlot(slot: 0 | 1, voiceId: string) {
    const nextSlots: [string, string] = [...voiceSlots];
    nextSlots[slot] = voiceId;
    setVoiceSlots(nextSlots);
    setVoiceIds(Object.fromEntries(characters.map((character, index) => {
      const assignment = voiceCount === 1 ? 0 : voiceAssignments[character.key] ?? (index % 2) as 0 | 1;
      return [character.key, nextSlots[assignment]];
    })));
  }

  function assignCharacterVoice(characterKey: string, slot: 0 | 1) {
    setVoiceAssignments((current) => ({ ...current, [characterKey]: slot }));
    setVoiceIds((current) => ({ ...current, [characterKey]: voiceSlots[slot] }));
  }

  async function saveVoiceMappings(): Promise<boolean> {
    if (!episodeId) return false;
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
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save voice mappings.');
      return false;
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

  async function deleteFailedChunk(batch: Batch, chunk: Chunk) {
    setBusy(true); setError('');
    try {
      await request(`/api/generation-batches/${batch.id}/failed-chunks`, { method: 'DELETE' });
      const result = await request<{ batch: Batch; chunks: Chunk[] }>(`/api/generation-batches/${batch.id}`);
      setChunks((current) => [...current.filter((item) => item.batchId !== batch.id), ...result.chunks]);
      setBatches((current) => current.map((item) => item.id === batch.id ? result.batch : item));
      setNotice('Failed generated data removed.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not remove failed generated data.');
    } finally { setBusy(false); }
  }

  async function deleteFailedBatch(batch: Batch) {
    setBusy(true); setError('');
    try {
      await request(`/api/generation-batches/${batch.id}`, { method: 'DELETE' });
      setChunks((current) => current.filter((chunk) => chunk.batchId !== batch.id));
      setBatches((current) => current.filter((item) => item.id !== batch.id));
      setNotice('Failed generation and its data removed.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not remove failed generation.');
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
      setSelectedAudioId(result.transcription.audioId);
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

  async function createVideo(saveAsDraft = false) {
    if (!videoAudioId) {
      setError('Choose a final audio mix first.');
      return;
    }
    if (!saveAsDraft && videoMode === 'elevenlabs' && !videoPrompt.trim()) {
      setError('Describe the video you want ElevenLabs to generate.');
      return;
    }
    if (!saveAsDraft && videoMode === 'uploaded' && selectedVideoClipIds.length === 0) {
      setError('Upload and select at least one video clip.');
      return;
    }
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await request<{ video: Video }>(`/api/audio/${videoAudioId}/video`, {
        method: 'POST',
        body: JSON.stringify({
          mode: videoMode,
          saveAsDraft,
          draftId: videoDraftId || undefined,
          title: videoTitle.trim() || 'Episode video',
          aspectRatio: videoAspectRatio,
          resolution: videoResolution,
          prompt: videoMode === 'elevenlabs' ? videoPrompt.trim() : undefined,
          clipIds: videoMode !== 'elevenlabs' ? selectedVideoClipIds : undefined,
          ghostStyle: videoMode === 'ghost' ? ghostStyle : undefined,
          subtitleId: videoSubtitleId || undefined,
          subtitleStyle: { animation: captionAnimation, fontFamily: captionFontFamily, fontSize: captionFontSize, fontWeight: captionFontWeight, textColor: captionTextColor, highlightColor: captionHighlightColor, preset: videoPreset, intensity: editIntensity },
          musicTracks: selectedMusic.map((track, orderIndex) => ({ ...track, orderIndex })),
          voiceVolume,
          editEvents: videoEditEvents.map((event, orderIndex) => ({ ...event, orderIndex })),
        }),
      });
      setVideos((current) => [result.video, ...current.filter((video) => video.id !== result.video.id)]);
      if (saveAsDraft) setVideoDraftId(result.video.id);
      if (saveAsDraft) loadedVideoDraftId.current = result.video.id;
      setNotice(saveAsDraft ? 'Video settings saved as a draft.' : videoMode === 'elevenlabs'
        ? 'ElevenLabs is generating a visual clip; it will be combined with your audio when ready.'
        : videoMode === 'ghost'
          ? 'Ghost Editor is analyzing your footage and script with Claude, then rendering your reel.'
          : 'Video export started; the selected clips will be combined with your audio.');
      await refreshEpisode(episodeId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start video rendering.');
    } finally { setBusy(false); }
  }

  function analyzeEditTimeline() {
    const transcription = transcriptions.find((item) => item.audioId === videoAudioId && item.status === 'COMPLETED' && item.segments?.length);
    if (!transcription?.segments?.length) {
      setError('Transcribe this final audio in Step 06 first so the editor can align suggestions to spoken word timings.');
      return;
    }
    const plan = createSmartEditPlan(transcription.segments);
    setVideoEditEvents(plan);
    setNotice(plan.length ? `Created ${plan.length} timed emphasis and reaction events. Review the timeline before exporting.` : 'No strong punctuation or emphasis cues were detected in this transcription. You can add timeline events manually.');
  }

  function addEditEvent(track: VideoEditTrack) {
    const asset = musicAssets.find((item) => item.status === 'READY');
    setVideoEditEvents((current) => [...current, {
      id: crypto.randomUUID(), track, startSeconds: 0, endSeconds: 1.2, text: track === 'sticker' ? '✨' : '',
      animation: 'pop', position: 'center', scale: 1, opacity: 1, volume: 0.2, enabled: true, orderIndex: current.length,
      musicAssetId: track === 'sound-effect' ? asset?.id ?? null : null,
      effect: track === 'visual-effect' ? 'flash' : null,
    }]);
  }

  function updateEditEvent(eventId: string, update: Partial<VideoEditEvent>) {
    setVideoEditEvents((current) => current.map((event) => event.id === eventId ? { ...event, ...update } : event));
  }

  async function saveCurrentStepAsDraft() {
    if (tab === 'script') {
      if (script.trim() && (scriptDirty.current || !scriptRecord)) await saveScript();
      else setNotice('Your script is already saved.');
      return;
    }
    if (tab === 'voices') {
      if (!voiceReady) { setError(voiceCount === 2 ? 'Choose two different voices and map every speaker.' : 'Choose a voice and map every speaker.'); return; }
      await saveVoiceMappings();
      return;
    }
    if (tab === 'video') { await createVideo(true); return; }
    setNotice('This step saves changes automatically. Your current selections are preserved while you continue.');
  }

  function cancelWorkflow() {
    setError('');
    setNotice('');
    setPage('projects');
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

  async function uploadMusicFiles() {
    if (!episodeId || !musicFiles.length) return;
    setBusy(true); setError(''); setMusicUploadProgress('Preparing uploads…');
    const files = [...musicFiles]; let uploaded = 0;
    try {
      for (const file of files) {
        if (file.size > 100 * 1024 * 1024) throw new Error(`${file.name} exceeds 100 MB.`);
        const isMp3 = file.type === 'audio/mpeg' || file.name.toLowerCase().endsWith('.mp3');
        const isMp4 = ['audio/mp4','video/mp4'].includes(file.type) || file.name.toLowerCase().endsWith('.mp4');
        if (!isMp3 && !isMp4) throw new Error(`${file.name} must be MP3 or MP4.`);
        setMusicUploadProgress(`Uploading ${uploaded + 1}/${files.length}: ${file.name}`);
        const response = await fetch(`${apiUrl}/api/episodes/${episodeId}/music?name=${encodeURIComponent(file.name)}`, { method:'POST', headers:{'content-type': isMp3 ? 'audio/mpeg' : 'audio/mp4'}, body:file });
        const result = await response.json().catch(() => ({})) as { error?:{message?:string}; music?:MusicAsset };
        if (!response.ok || !result.music) throw new Error(result.error?.message ?? `Upload failed for ${file.name}.`);
        setMusicAssets((current) => [result.music!, ...current]); uploaded++;
      }
      setMusicFiles([]); setNotice(`${uploaded} music file(s) added to the library.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Music upload failed.'); }
    finally { setBusy(false); setMusicUploadProgress(''); }
  }

  async function deleteMusic(id: string) {
    try { const response = await fetch(`${apiUrl}/api/music/${id}`, { method:'DELETE' }); const result = await response.json().catch(() => ({})) as {error?:{message?:string}}; if (!response.ok) throw new Error(result.error?.message ?? 'Could not delete music.'); setMusicAssets((current) => current.filter((item) => item.id !== id)); setSelectedMusic((current) => current.filter((item) => item.musicId !== id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not delete music.'); }
  }

  function updateMusicTrack(musicId: string, changes: Partial<MusicPick>) {
    const asset = musicAssets.find((item) => item.id === musicId);
    const cleanNumber = (value: number | undefined, fallback: number, min: number, max: number) => {
      const candidate = value ?? fallback;
      return Number.isFinite(candidate) ? Math.max(min, Math.min(candidate, max)) : fallback;
    };
    setSelectedMusic((current) => current.map((track) => {
      if (track.musicId !== musicId) return track;
      const maxStart = Math.max(0, (asset?.durationSeconds ?? Number.MAX_SAFE_INTEGER) - 0.05);
      const startSeconds = cleanNumber(changes.startSeconds, track.startSeconds, 0, maxStart);
      const candidateEnd = changes.endSeconds === undefined ? track.endSeconds : changes.endSeconds;
      const endSeconds = candidateEnd !== null && candidateEnd > startSeconds
        ? cleanNumber(candidateEnd, startSeconds, startSeconds + 0.05, asset?.durationSeconds ?? Number.MAX_SAFE_INTEGER)
        : null;
      return {
        ...track, ...changes,
        volume: cleanNumber(changes.volume, track.volume, 0, 1),
        startSeconds, endSeconds,
        outputStartSeconds: cleanNumber(changes.outputStartSeconds, track.outputStartSeconds, 0, Number.MAX_SAFE_INTEGER),
        fadeInSeconds: cleanNumber(changes.fadeInSeconds, track.fadeInSeconds, 0, 60),
        fadeOutSeconds: cleanNumber(changes.fadeOutSeconds, track.fadeOutSeconds, 0, 60),
      };
    }));
  }

  function moveVideoClip(index: number, offset: number) {
    const next = [...selectedVideoClipIds];
    const target = index + offset;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setSelectedVideoClipIds(next);
  }

  function moveMusicTrack(index: number, offset: number) {
    const next = [...selectedMusic]; const target = index + offset;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    let cursor = 0;
    setSelectedMusic(next.map((track) => { const asset=musicAssets.find((item)=>item.id===track.musicId); const duration=Math.max(0,(track.endSeconds??asset?.durationSeconds??0)-track.startSeconds); const placed={...track,outputStartSeconds:cursor}; cursor+=duration; return placed; }));
  }

  function moveTimelineItem(index: number, offset: number) {
    const next = [...selectedAudioIds];
    const target = index + offset;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setSelectedAudioIds(next);
  }

  return (
    page !== 'studio' ? <main className="dashboard-shell">
      <aside className="dashboard-sidebar"><a className="brand" href="#" onClick={(e) => { e.preventDefault(); setPage('home'); }}><span className="brand-mark">s</span><span>sonora<span className="brand-dot">.</span></span></a><div className="workspace-label">WORKSPACE</div>
        <nav className="dashboard-nav"><button className={page === 'home' ? 'active' : ''} onClick={() => setPage('home')}>⌂ <span>Overview</span></button><button className={page === 'projects' ? 'active' : ''} onClick={() => setPage('projects')}>▦ <span>Projects</span><small>{projects.length}</small></button><button className={page === 'history' ? 'active' : ''} onClick={() => setPage('history')}>◷ <span>History</span></button></nav>
        <div className="dashboard-local"><span className={`api-led ${apiOnline ? 'connected' : ''}`} /><span><b>Local workspace</b><small>{apiOnline ? 'API connected' : 'API offline'}</small></span></div>
      </aside><section className="dashboard-main"><header className="dashboard-topbar"><span>SONORA STUDIO <i>/</i> {page === 'home' ? 'OVERVIEW' : page.toUpperCase()}</span><span className={`api-status ${apiOnline ? 'online' : ''}`}><span />{apiOnline ? 'API connected' : 'API offline'}</span></header>
        <div className="dashboard-content">{page === 'home' ? <>
          <div className="landing-hero"><div className="eyebrow"><span className="eyebrow-dot" /> YOUR LOCAL PODCAST WORKSPACE</div><h1>Every voice has<br /><em>a story to tell.</em></h1><p>Turn a script into a polished, multi-speaker podcast. Shape the voices, build your mix, and bring the story to video — all from one calm workspace.</p><button className="primary-button" onClick={() => setPage('projects')}>Open your projects <span>→</span></button><div className="hero-note">SCRIPT → VOICES → AUDIO → VIDEO</div><div className="hero-art"><div className="hero-orb" /><div className="hero-wave">〰</div><div className="hero-card"><span>NOW IN YOUR STUDIO</span><b>Stories made<br />for listening.</b><i>✳</i></div></div></div>
          <div className="dashboard-section-head"><div><span className="section-kicker">YOUR WORKSPACE</span><h2>Pick up where you left off</h2><p>Your projects stay right here on your device.</p></div><button className="text-button" onClick={() => setPage('projects')}>All projects →</button></div>
          <div className="dashboard-grid">{projects.slice(0, 3).map((project, index) => { const eps = allEpisodes.filter((episode) => episode.projectId === project.id); const active = eps[0]; const createdToday = wasCreatedToday(project.createdAt); return <button className={`dashboard-project ${createdToday ? 'created-today' : ''}`} key={project.id} onClick={() => { if (active) { setProjectId(project.id); setEpisodeId(active.id); setPage('studio'); } else { setProjectId(project.id); setEpisodeId(''); setPage('studio'); } }}><span className={`project-art art-${index % 3}`}><i>✳</i><small>{String(eps.length).padStart(2, '0')} EPISODES</small></span><span className="dashboard-project-name"><b>{project.name}</b>{createdToday && <em className="today-badge"><i />Created today</em>}</span><small>{active?.title ?? 'Ready for your first episode'}</small></button>; })}<button className="dashboard-new" onClick={() => setPage('projects')}><span>＋</span><b>Start a new project</b><small>Give your next story a home</small></button></div>
          <div className="landing-features"><div><span>01</span><b>Shape the conversation</b><p>Write or refine a script with distinct speaker turns and expressive delivery.</p></div><div><span>02</span><b>Find every voice</b><p>Assign voices, generate dialogue, and keep each audio take organized.</p></div><div><span>03</span><b>Finish your story</b><p>Compose a final mix, create subtitles, and export a video when you’re ready.</p></div></div>
        </> : page === 'projects' ? <><div className="dashboard-section-head"><div><span className="section-kicker">WORKSPACE LIBRARY</span><h1>Your projects</h1><p>Search, filter and sort your work, then jump back into any episode.</p></div></div><form className="project-create-form" onSubmit={(e) => { e.preventDefault(); createProject(); }}><input aria-label="New project name" value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)} placeholder="Name your project" /><button className="primary-button" disabled={busy}>? New project</button></form><div className="project-table-tools"><label className="project-search"><span>?</span><input value={projectSearch} onChange={(e) => setProjectSearch(e.target.value)} placeholder="Search projects?" aria-label="Search projects" /></label><label>FILTER<select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value as typeof projectFilter)}><option value="all">All projects</option><option value="today">Created today</option><option value="with-episodes">Has episodes</option><option value="empty">No episodes</option></select></label><label>SORT BY<select value={projectSort} onChange={(e) => setProjectSort(e.target.value as typeof projectSort)}><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="name-asc">Name A?Z</option><option value="name-desc">Name Z?A</option></select></label></div><div className="project-table-wrap"><table className="project-table"><thead><tr><th>PROJECT</th><th>EPISODES</th><th>CREATED</th><th>UPDATED</th><th></th></tr></thead><tbody>{visibleProjects.map((project) => { const eps = allEpisodes.filter((episode) => episode.projectId === project.id); const createdToday = wasCreatedToday(project.createdAt); const latest = eps.slice().sort((a,b) => new Date(b.updatedAt ?? b.createdAt ?? 0).getTime() - new Date(a.updatedAt ?? a.createdAt ?? 0).getTime())[0]; return <tr className={createdToday ? 'created-today' : ''} key={project.id}><td><span className="table-project-cell"><i className="table-project-icon">?</i><span><b>{project.name}</b>{createdToday && <em className="today-badge"><i />Created today</em>}</span></span></td><td><span className="episode-count">{eps.length}</span>{latest && <small className="table-episode-name">Latest: {latest.title}</small>}</td><td>{project.createdAt ? new Date(project.createdAt).toLocaleDateString() : '?'}</td><td>{project.updatedAt ? new Date(project.updatedAt).toLocaleDateString() : '?'}</td><td><div className="table-actions">{latest && <button className="text-button" onClick={() => { setProjectId(project.id); setEpisodeId(latest.id); setPage('studio'); }}>Continue ?</button>}<button className="table-open" onClick={() => { setProjectId(project.id); setEpisodeId(''); setPage('studio'); }}>Open</button></div></td></tr>; })}{!visibleProjects.length && <tr><td colSpan={5} className="project-table-empty">No projects match your search and filters.</td></tr>}</tbody></table></div></> : <><div className="dashboard-section-head"><div><span className="section-kicker">RECENT OUTPUTS</span><h1>Creation history</h1><p>Generated audio and video across all your projects.</p></div></div><div className="history-list">{historyItems.flatMap(({ episode, project, audios: episodeAudios, videos: episodeVideos }) => [...episodeAudios.map((audio) => ({ id: audio.id, title: audio.label, kind: audio.kind === 'final' ? 'FINAL MIX' : 'AUDIO TAKE', status: 'READY', date: (audio as Audio & { createdAt?: string }).createdAt, project, episode, href: `${apiUrl}/api/audio/${audio.id}/download` })), ...episodeVideos.map((video) => ({ id: video.id, title: video.title, kind: 'VIDEO', status: video.status, date: video.createdAt, project, episode, href: `${apiUrl}/api/videos/${video.id}/download` }))]).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')).map((item) => <article className="history-row" key={item.id}><span className="history-icon">{item.kind === 'VIDEO' ? '▶' : '♫'}</span><span className="history-title"><b>{item.title}</b><small>{item.project.name} / {item.episode.title} · {item.kind}</small></span><small className="history-date">{item.date ? new Date(item.date).toLocaleString() : 'Created'}</small><span className={`history-status ${item.status.toLowerCase()}`}>{item.status}</span>{item.status === 'READY' ? <a className="history-download" href={item.href} download>↓</a> : <span className="history-download">·</span>}<button className="history-open" onClick={() => { setProjectId(item.project.id); setEpisodeId(item.episode.id); setPage('studio'); }}>Open ↗</button></article>)}</div>{historyItems.every((item) => !item.audios.length && !item.videos.length) && <div className="dashboard-empty">No generated media yet. Start an episode to see finished audio and video here.</div>}</>}</div>
      </section>
    </main> :
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
        <header className="topbar"><div className="breadcrumbs"><button className="back-dashboard" onClick={() => { setPage('projects'); refreshDashboard().catch(() => undefined); }}>← Projects</button><span className="crumb-slash">/</span><strong>{episodes.find((episode) => episode.id === episodeId)?.title ?? 'New episode'}</strong></div><div className={`api-status ${apiOnline ? 'online' : ''}`}><span />{apiOnline ? 'API connected' : 'API offline'}</div></header>
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

            {tab === 'voices' && <section className="workspace-card voice-workspace-card">
              <div className="workspace-card-heading"><div><div className="section-kicker">STEP 02 · VOICE CAST</div><h2>Choose your cast</h2><p>Use one narrator voice or two voices for a conversation.</p></div><span className="script-icon">♫</span></div>
              {!scriptRecord && <div className="inline-empty">Save a script first to detect speakers. <button className="text-button" onClick={() => setTab('script')}>Go to script →</button></div>}
              <div className="voice-count-switch" role="group" aria-label="Number of voices">
                <button type="button" data-choice="1" className={voiceCount === 1 ? 'selected' : ''} onClick={() => selectVoiceCount(1)}><strong>1 voice</strong><small>Single-speaker narration</small></button>
                <button type="button" data-choice="2" className={voiceCount === 2 ? 'selected' : ''} disabled={characters.length < 2} onClick={() => selectVoiceCount(2)}><strong>2 voices</strong><small>Conversation between speakers</small></button>
              </div>
              <div className="voice-slot-grid">
                {Array.from({ length: voiceCount }, (_, slotIndex) => {
                  const slot = slotIndex as 0 | 1;
                  const selectedVoice = voices.find((voice) => voice.voiceId === voiceSlots[slot]);
                  return <div className="voice-slot-card" key={slot}>
                    <div className="voice-slot-label"><span className="voice-avatar">{slot === 0 ? '1' : '2'}</span><div><strong>{voiceCount === 1 ? 'Narrator voice' : `Conversation voice ${slot + 1}`}</strong><small>{voiceCount === 1 ? 'Used for every speaker in this script' : `Assigned to ${characters.filter((character, index) => (voiceAssignments[character.key] ?? index % 2) === slot).length} speaker(s)`}</small></div></div>
                    <select size={1} value={voiceSlots[slot]} onChange={(event) => updateVoiceSlot(slot, event.target.value)}><option value="">Choose a voice</option>{voices.map((voice) => <option key={voice.voiceId} value={voice.voiceId}>{voice.name} · {voice.category ?? 'voice'}</option>)}</select>
                    <input aria-label={`${voiceCount === 1 ? 'Narrator' : `Conversation voice ${slot + 1}`} voice ID`} value={voiceSlots[slot]} onChange={(event) => updateVoiceSlot(slot, event.target.value)} placeholder="Or paste ElevenLabs voice ID" />
                    {selectedVoice?.previewUrl && <audio className="voice-preview" controls preload="none" src={selectedVoice.previewUrl} />}
                  </div>;
                })}
              </div>
              {voiceCount === 2 && <div className="speaker-assignment-list"><div className="subsection-heading"><strong>Assign speakers</strong><span>Each speaker uses one of the two selected voices.</span></div>{characters.map((character, index) => <div className="speaker-assignment-row" key={character.key}><span className="voice-avatar">{character.name.slice(0, 1).toUpperCase()}</span><strong>{character.name}</strong><select value={voiceAssignments[character.key] ?? (index % 2)} onChange={(event) => assignCharacterVoice(character.key, Number(event.target.value) as 0 | 1)}><option value={0}>Voice 1 · {voices.find((voice) => voice.voiceId === voiceSlots[0])?.name || 'Choose voice 1'}</option><option value={1}>Voice 2 · {voices.find((voice) => voice.voiceId === voiceSlots[1])?.name || 'Choose voice 2'}</option></select></div>)}</div>}
              {voiceError && <p className="muted-notice">{voiceError} You can still enter voice IDs manually. <button className="text-button" onClick={loadVoices}>Retry loading voices</button></p>}
              <div className="editor-footer"><span className="script-metrics">{mappedCount} of {characters.length} speakers mapped</span><button className="analyze-button" disabled={busy || !voiceReady} onClick={saveVoiceMappings}>{busy ? 'Saving…' : 'Save voice mappings'} <span>→</span></button></div>
            </section>}

            {tab === 'generation' && <section className="workspace-card">
              <div className="workspace-card-heading"><div><div className="section-kicker">STEP 03 · GENERATION</div><h2>Generate your dialogue</h2><p>Your script is split into requests of at most 2,000 characters, then processed in the background.</p></div><span className="script-icon">◉</span></div>
              <div className="generation-summary"><div><small>SCRIPT</small><strong>{scriptRecord ? `Version ${scriptRecord.version}` : 'Not saved'}</strong></div><div><small>SPEAKERS</small><strong>{mappedCount} mapped</strong></div><div><small>CHUNKS</small><strong>{Math.max(1, Math.ceil(script.length / 2000))} estimated</strong></div><div><small>MODEL</small><strong>{modelId}</strong></div></div>
              <div className="advanced-options"><label>TEXT NORMALIZATION<select value={normalization} onChange={(event) => setNormalization(event.target.value as 'auto' | 'on' | 'off')}><option value="auto">Auto</option><option value="on">On</option><option value="off">Off</option></select></label><label>SEED (OPTIONAL)<input type="number" value={seed} onChange={(event) => setSeed(event.target.value)} placeholder="Random" /></label><button className="text-button" onClick={previewPayload} disabled={busy || !scriptRecord}>Preview payload</button></div>
              {payloadPreview && <div className="payload-panel"><div className="payload-tabs"><button className={payloadView === 'visual' ? 'active' : ''} onClick={() => setPayloadView('visual')}>Summary</button><button className={payloadView === 'json' ? 'active' : ''} onClick={() => setPayloadView('json')}>JSON</button></div>{payloadView === 'json' ? <pre>{payloadPreview}</pre> : <p>{lines.length} dialogue turns · {characters.length} speakers · 2,000 character limit per request. Review the JSON view before generating.</p>}</div>}
              <button className="primary-button large-button" disabled={busy || !scriptRecord || !voiceReady} onClick={createAndStartBatch}>{busy ? 'Queueing…' : '▶  Generate audio'}</button>
              {batches.map((batch) => { const failedChunks = chunks.filter((chunk) => chunk.batchId === batch.id && chunk.status === 'FAILED'); const batchChunks = chunks.filter((chunk) => chunk.batchId === batch.id); const allFailed = batchChunks.length > 0 && batchChunks.every((chunk) => chunk.status === 'FAILED'); return <div className="batch-card" key={batch.id}><div className="batch-top"><strong>{batch.label}</strong><span className={`batch-status ${batch.status.toLowerCase()}`}>{batch.status}</span></div><div className="batch-progress"><i style={{ width: `${batch.totalChunks ? batch.completedChunks / batch.totalChunks * 100 : 0}%` }} /></div><small>{batch.completedChunks}/{batch.totalChunks} complete · {failedChunks.length} failed</small>{failedChunks.map((chunk) => <div className="failed-chunk-row" key={chunk.id}><p className="chunk-failure">Chunk {chunk.chunkIndex}: {chunk.errorMessage}</p><button className="text-button delete-failed" disabled={busy} onClick={() => deleteFailedChunk(batch, chunk)}>Delete failed data</button></div>)}{failedChunks.length > 0 && <div className="failed-actions"><button className="text-button" disabled={busy} onClick={() => retryBatch(batch)}>Retry failed chunks →</button>{allFailed && <button className="text-button delete-failed" disabled={busy} onClick={() => deleteFailedBatch(batch)}>Delete failed generation</button>}</div>}</div>; })}
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
              <label className="field-label">FINAL AUDIO<select value={selectedAudioId} onChange={(event) => setSelectedAudioId(event.target.value)}><option value="">{audios.some((audio) => audio.kind === 'final') ? 'Choose final MP3' : 'No final MP3 yet — create one in Composer'}</option>{audios.filter((audio) => audio.kind === 'final').map((audio) => <option key={audio.id} value={audio.id}>{audio.label} · {audio.durationSeconds ? `${audio.durationSeconds.toFixed(1)} sec` : 'MP3'} · {audio.id.slice(0, 8)}</option>)}</select></label>
              <button className="analyze-button" disabled={busy || !selectedAudioId} onClick={transcribeAudio}>{busy ? 'Transcribing…' : 'Transcribe selected audio'} <span>→</span></button>
              {transcriptions.filter((transcription) => transcription.audioId === selectedAudioId).map((transcription) => <div className="transcript-card" key={transcription.id}><div className="batch-top"><strong>Transcription · {audios.find((audio) => audio.id === transcription.audioId)?.label ?? 'Selected MP3'}</strong><span className={`batch-status ${transcription.status.toLowerCase()}`}>{transcription.status}</span></div><p className="transcript-text">{transcription.text}</p><textarea aria-label="Edit generated subtitle" value={subtitleContent} onChange={(event) => setSubtitleContent(event.target.value)} placeholder="Generate SRT or VTT to edit subtitle text" /><div className="editor-footer"><button className="text-button" onClick={() => generateSubtitles(transcription, 'srt')} disabled={busy || transcription.status !== 'COMPLETED'}>Generate SRT</button><button className="text-button" onClick={() => generateSubtitles(transcription, 'vtt')} disabled={busy || transcription.status !== 'COMPLETED'}>Generate VTT</button>{subtitleId && <><button className="text-button" onClick={async () => { try { const saved = await request<{ subtitle: { id: string; content: string } }>(`/api/transcriptions/${transcription.id}/generate-srt`, { method: 'POST', body: JSON.stringify({ format: subtitleContent.startsWith('WEBVTT') ? 'vtt' : 'srt', content: subtitleContent }) }); setSubtitleId(saved.subtitle.id); setNotice('Subtitle changes saved.'); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save subtitle.'); } }}>Save edits</button><a className="text-button" href={`${apiUrl}/api/subtitles/${subtitleId}/download`}>Download ↓</a></>}</div></div>)}
              {!transcriptions.some((transcription) => transcription.audioId === selectedAudioId) && <p className="muted-notice">{selectedAudioId ? 'No transcription for this MP3 yet. Select Transcribe to generate subtitles from the selected final mix.' : 'Choose a final MP3 created from your current voice generation. Speech-to-text requires a configured ElevenLabs API key.'}</p>}
            </section>}

            {tab === 'video' && <section className="workspace-card video-workspace-card">
              <div className="workspace-card-heading"><div><div className="section-kicker">STEP 07 · VIDEO EXPORT</div><h2>Build your episode video</h2><p>Choose an ElevenLabs-generated visual or assemble your own clips with the final voice track.</p></div><span className="script-icon">▶</span></div>
              <div className="video-editor-layout"><div className="video-setup-column"><div className="video-section-card"><h3>Video setup</h3><p>Choose the audio and visual source for this export.</p>
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
              </>}</div></div>
              <div className="video-enhance-panel">
                <div className="workspace-card-heading"><div><div className="section-kicker">AUDIO MIX</div><h3>Background music</h3><p>Upload a music library for this episode and mix tracks beneath narration.</p></div></div>
                <label className="field-label">UPLOAD MP3 / MP4 FILES<input type="file" accept=".mp3,.mp4,audio/mpeg,audio/mp4,video/mp4" multiple onChange={(event) => { setMusicFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value=''; }} /></label>
                <p className="muted-notice">Up to 100 MB each. MP4 uploads must contain an audio stream. {musicUploadProgress}</p>
                <button className="text-button" disabled={busy || !musicFiles.length} onClick={uploadMusicFiles}>Upload {musicFiles.length || ''} music file(s) ↑</button>
                <div className="music-library">{musicAssets.map((item) => { const pick = selectedMusic.find((track) => track.musicId === item.id); return <div className={'music-library-item '+(pick?'music-selected':'')} key={item.id}>
                  <label><input type="checkbox" checked={!!pick} onChange={(event) => setSelectedMusic((current) => { if(!event.target.checked)return current.filter((track)=>track.musicId!==item.id); const previous=current.at(-1); const previousAsset=previous&&musicAssets.find((asset)=>asset.id===previous.musicId); const offset=previous&&previousAsset?previous.outputStartSeconds+Math.max(0,(previous.endSeconds??previousAsset.durationSeconds)-previous.startSeconds):0; return [...current,{musicId:item.id,volume:0.2,startSeconds:0,endSeconds:null,outputStartSeconds:offset,fadeInSeconds:0,fadeOutSeconds:0}]; })}/><span><strong>{item.name}</strong><small>{item.durationSeconds.toFixed(1)} sec · {item.format.toUpperCase()} · {item.status}</small></span></label>
                  <audio controls preload="none" src={`${apiUrl}/api/music/${item.id}/preview`} />
                  <button className="text-button" onClick={() => void deleteMusic(item.id)}>Delete</button>
                  {pick && <div className="music-track-controls"><label>Volume <input type="range" min="0" max="1" step="0.01" value={pick.volume} onChange={(event) => updateMusicTrack(item.id,{volume:Number(event.target.value)})}/></label><label>Music start (s)<input type="number" min="0" step="0.1" value={pick.startSeconds} onChange={(event) => updateMusicTrack(item.id,{startSeconds:Number(event.target.value)})}/></label><label>Music end (s)<input type="number" min="0" step="0.1" placeholder="End of file" value={pick.endSeconds ?? ''} onChange={(event) => updateMusicTrack(item.id,{endSeconds:event.target.value?Number(event.target.value):null})}/></label><label>Start in video (s)<input type="number" min="0" step="0.1" value={pick.outputStartSeconds} onChange={(event) => updateMusicTrack(item.id,{outputStartSeconds:Number(event.target.value)})}/></label><label>Fade in (s)<input type="number" min="0" max="60" step="0.1" value={pick.fadeInSeconds} onChange={(event) => updateMusicTrack(item.id,{fadeInSeconds:Number(event.target.value)})}/></label><label>Fade out (s)<input type="number" min="0" max="60" step="0.1" value={pick.fadeOutSeconds} onChange={(event) => updateMusicTrack(item.id,{fadeOutSeconds:Number(event.target.value)})}/></label><button className="text-button" disabled={selectedMusic.findIndex((t)=>t.musicId===item.id)===0} onClick={()=>moveMusicTrack(selectedMusic.findIndex((t)=>t.musicId===item.id),-1)}>↑ Earlier</button><button className="text-button" disabled={selectedMusic.findIndex((t)=>t.musicId===item.id)===selectedMusic.length-1} onClick={()=>moveMusicTrack(selectedMusic.findIndex((t)=>t.musicId===item.id),1)}>↓ Later</button></div>}
                </div>; })}</div>
                <label className="field-label">VOICE VOLUME<input type="range" min="0" max="2" step="0.01" value={voiceVolume} onChange={(event)=>setVoiceVolume(Number(event.target.value))}/></label>
                {videoAudioId && <label className="field-label">VOICE PREVIEW<audio controls preload="none" src={`${apiUrl}/api/audio/${videoAudioId}/stream`} /></label>}
                <label className="field-label">SUBTITLES<select value={videoSubtitleId} onChange={(event) => setVideoSubtitleId(event.target.value)}><option value="">No subtitles</option>{subtitles.filter((subtitle) => ['srt', 'vtt'].includes(subtitle.format) && transcriptions.some((transcription) => transcription.id === subtitle.transcriptionId && transcription.audioId === videoAudioId && transcription.status === 'COMPLETED')).map((subtitle) => <option key={subtitle.id} value={subtitle.id}>{subtitle.format.toUpperCase()} · {new Date(subtitle.createdAt).toLocaleString()}</option>)}</select></label>
                <div className="caption-controls">
                  <label className="field-label">EDITING PRESET<select value={videoPreset} onChange={(event) => setVideoPreset(event.target.value as VideoPreset)}><option value="tiktok">TikTok Viral</option><option value="cinematic">Cinematic</option><option value="meme">Funny / Meme</option><option value="minimal">Minimal Aesthetic</option><option value="storytelling">Storytelling</option><option value="podcast">Podcast / Talking Head</option><option value="energetic">Energetic / Music Style</option></select></label>
                  <label className="field-label">EDIT INTENSITY<select value={editIntensity} onChange={(event) => setEditIntensity(event.target.value as EditIntensity)}><option value="subtle">Subtle</option><option value="balanced">Balanced</option><option value="creative">Creative</option></select></label>
                  <label className="field-label">TEXT ANIMATION<select value={captionAnimation} onChange={(event) => setCaptionAnimation(event.target.value as CaptionAnimation)}><option value="edit">Expressive Edit · punctuation and caps emphasis</option><option value="karaoke">Karaoke Highlight</option><option value="word-reveal">Word-by-Word Reveal</option><option value="pop">Pop In / Pop Out</option><option value="bounce">Bounce</option><option value="typewriter">Typewriter</option><option value="scale-punch">Scale Punch</option><option value="slide">Slide In / Out</option><option value="fade">Fade In / Out</option><option value="shake">Shake</option><option value="elastic">Elastic</option><option value="glitch">Glitch Text</option><option value="rotation">Rotation</option><option value="blur">Blur Reveal</option><option value="wave">Wave Text</option><option value="tracking">Tracking Animation</option><option value="stagger">Staggered Text</option></select></label>
                  <label className="field-label">FONT LIBRARY<select value={captionFontFamily} onChange={(event) => setCaptionFontFamily(event.target.value)}><optgroup label="Bold & Viral"><option>Anton</option><option>Bebas Neue</option><option>Oswald</option><option>Archivo Black</option><option>Impact</option><option>Arial Black</option></optgroup><optgroup label="Modern & Minimal"><option>Montserrat</option><option>Poppins</option><option>Inter</option><option>Roboto</option></optgroup><optgroup label="Cinematic & Elegant"><option>Playfair Display</option><option>Georgia</option></optgroup><optgroup label="Funny & Storytelling"><option>Bangers</option><option>Trebuchet MS</option><option>Arial</option></optgroup></select></label>
                  <label className="field-label">FONT SIZE · {captionFontSize}px<input type="range" min="28" max="100" step="1" value={captionFontSize} onChange={(event) => setCaptionFontSize(Number(event.target.value))} /></label>
                  <label className="field-label">FONT WEIGHT<select value={captionFontWeight} onChange={(event) => setCaptionFontWeight(event.target.value as typeof captionFontWeight)}><option value="regular">Regular</option><option value="medium">Medium</option><option value="bold">Bold</option><option value="extra-bold">Extra Bold</option></select></label>
                  <label className="field-label">TEXT COLOR<input type="color" value={captionTextColor} onChange={(event) => setCaptionTextColor(event.target.value)} /></label>
                  {captionAnimation !== 'word' && <label className="field-label">ACTIVE WORD COLOR<input type="color" value={captionHighlightColor} onChange={(event) => setCaptionHighlightColor(event.target.value)} /></label>}
                </div>
                <div className={`caption-live-preview ${captionAnimation === 'edit' ? 'caption-edit-preview' : ''}`}>
                  <span className="caption-preview-label">LIVE CAPTION PREVIEW</span>
                  <div style={{ fontFamily: captionFontFamily, color: captionTextColor, fontSize: `${Math.max(20, captionFontSize / 1.7)}px`, fontWeight: captionFontWeight === 'extra-bold' || captionFontWeight === 'bold' ? 900 : captionFontWeight === 'medium' ? 600 : 400 }}><strong>SIÊU TIỆN LỢI</strong><b style={{ color: captionHighlightColor }}> ‼</b></div>
                  <small>Edit style enlarges emphatic words and accents excited or questioning phrases during playback.</small>
                </div>
                <p className="muted-notice">Captions follow the word timestamps from the selected transcription.</p>
              </div></div>
              <section className="video-timeline-panel">
                <div className="timeline-panel-heading"><div><span className="section-kicker">SMART EDIT TIMELINE</span><h3>Review and tune edit suggestions</h3><p>Suggestions use transcription word timings. Every enabled event below is included in the final render.</p></div><button className="text-button" disabled={!transcriptions.some((item) => item.audioId === videoAudioId && item.status === 'COMPLETED' && item.segments?.length)} onClick={analyzeEditTimeline}>Analyze voice &amp; suggest edits</button></div>
                <div className="timeline-add-actions"><button onClick={() => addEditEvent('typography')}>＋ Text</button><button onClick={() => addEditEvent('sticker')}>＋ Sticker</button><button onClick={() => addEditEvent('visual-effect')}>＋ Visual effect</button><button onClick={() => addEditEvent('sound-effect')} disabled={!musicAssets.some((asset) => asset.status === 'READY')}>＋ Sound effect</button></div>
                <div className="edit-track-legend"><span>▰ Video</span><span>▰ Voice</span><span>▰ Typography</span><span>▰ Stickers</span><span>▰ Effects</span><span>▰ Sound</span><span>▰ Music</span></div>
                {!videoEditEvents.length && <div className="timeline-empty">No edit events yet. Analyze the selected audio or add a text, sticker, visual effect, or sound effect.</div>}
                <div className="video-edit-event-list">{videoEditEvents.slice().sort((a,b) => a.startSeconds-b.startSeconds || a.orderIndex-b.orderIndex).map((event) => <article className={`video-edit-event ${event.enabled ? '' : 'event-disabled'}`} key={event.id}>
                  <div className="edit-event-head"><label><input type="checkbox" checked={event.enabled} onChange={(e) => updateEditEvent(event.id,{enabled:e.target.checked})}/><span className={`edit-track-tag ${event.track}`}>{event.track}</span></label><span>{event.startSeconds.toFixed(2)}–{event.endSeconds.toFixed(2)}s</span><button aria-label="Remove timeline event" onClick={() => setVideoEditEvents((items) => items.filter((item) => item.id !== event.id))}>×</button></div>
                  <div className="edit-event-controls"><label>Start (s)<input type="number" min="0" step="0.05" value={event.startSeconds} onChange={(e) => updateEditEvent(event.id,{startSeconds:Math.max(0,Number(e.target.value))})}/></label><label>End (s)<input type="number" min="0.05" step="0.05" value={event.endSeconds} onChange={(e) => updateEditEvent(event.id,{endSeconds:Math.max(event.startSeconds+0.05,Number(e.target.value))})}/></label>
                    {['typography','sticker'].includes(event.track) && <label>Screen text<input value={event.text} maxLength={160} onChange={(e) => updateEditEvent(event.id,{text:e.target.value})}/></label>}
                    {event.track === 'sound-effect' && <label>Audio asset<select value={event.musicAssetId ?? ''} onChange={(e) => updateEditEvent(event.id,{musicAssetId:e.target.value})}><option value="">Choose sound</option>{musicAssets.filter((asset) => asset.status === 'READY').map((asset) => <option value={asset.id} key={asset.id}>{asset.name}</option>)}</select></label>}
                    {event.track === 'visual-effect' && <label>Effect<select value={event.effect ?? 'flash'} onChange={(e) => updateEditEvent(event.id,{effect:e.target.value})}><option value="flash">Flash</option><option value="vignette">Vignette</option><option value="soft-blur">Soft blur</option><option value="contrast">Contrast punch</option></select></label>}
                    {['typography','sticker'].includes(event.track) && <><label>Animation<select value={event.animation} onChange={(e) => updateEditEvent(event.id,{animation:e.target.value})}><option value="pop">Pop</option><option value="bounce">Bounce</option><option value="slide">Slide</option><option value="shake">Shake</option></select></label><label>Position<select value={event.position} onChange={(e) => updateEditEvent(event.id,{position:e.target.value as VideoEditEvent['position']})}><option value="top">Top</option><option value="center">Center</option><option value="bottom">Bottom</option></select></label><label>Size · {event.scale.toFixed(2)}×<input type="range" min="0.5" max="2.5" step="0.05" value={event.scale} onChange={(e) => updateEditEvent(event.id,{scale:Number(e.target.value)})}/></label></>}
                    {event.track === 'sound-effect' && <label>Volume · {Math.round(event.volume*100)}%<input type="range" min="0" max="1" step="0.01" value={event.volume} onChange={(e) => updateEditEvent(event.id,{volume:Number(e.target.value)})}/></label>}
                  </div>
                </article>)}</div>
              </section>
              <p className="muted-notice">SRT/VTT generated in Transcript &amp; Export for this final audio is selected automatically. Captions are burned into the video and included as a selectable subtitle track.</p>
              {!audios.some((audio) => audio.kind === 'final') && <div className="inline-empty">Create a final mix in Composer before exporting video. <button className="text-button" onClick={() => setTab('composer')}>Open composer →</button></div>}
              <div className="video-export-actions"><button className="text-button" disabled={busy || !videoAudioId} onClick={() => createVideo(true)}>{videoDraftId ? 'Update video draft' : 'Save video as draft'}</button><button className="analyze-button" disabled={busy || !videoAudioId || (videoMode !== 'elevenlabs' && !selectedVideoClipIds.length) || (videoMode === 'elevenlabs' && !videoPrompt.trim())} onClick={() => createVideo()}>{busy ? 'Starting…' : videoMode === 'ghost' ? 'Auto-edit reel with Claude' : 'Create MP4 video'} <span>→</span></button></div>
              {!!videos.length && <div className="video-list">{videos.map((video, index) => <div className={'video-entry ' + (previewVideoId === video.id ? 'preview-open' : '')} key={video.id}><div className="video-row"><div className="video-kind">{String(videos.length - index).padStart(2, '0')}</div><div className="audio-title"><strong>{video.title}</strong><small>{video.sourceMode === 'elevenlabs' ? 'ElevenLabs visual' : video.sourceMode === 'ghost' ? 'Ghost Editor reel' : video.sourceMode === 'uploaded' ? 'Uploaded clips' : 'Cover image'} ? {video.status === 'READY' ? ((video.aspectRatio ?? '16:9') + ' ? ' + (video.resolution ?? 720) + 'p ? ' + (video.sizeBytes / 1024 / 1024).toFixed(1) + ' MB') : video.status.toLowerCase()}</small>{video.errorMessage && <small className="chunk-failure">{video.errorMessage}</small>}</div><span className={'batch-status ' + video.status.toLowerCase()}>{video.status}</span>{video.status === 'READY' && <><button className="video-preview-toggle" onClick={() => setPreviewVideoId((current) => current === video.id ? '' : video.id)}>{previewVideoId === video.id ? 'Hide preview' : '? Preview'}</button><a className="download-link" href={apiUrl + '/api/videos/' + video.id + '/download'} download>?</a></>}</div>{previewVideoId === video.id && video.status === 'READY' && <div className="video-preview-wrap"><video className="video-preview" controls preload="metadata" src={apiUrl + '/api/videos/' + video.id + '/download'} /></div>}</div>)}</div>}
            </section>}
            <div className="workflow-action-bar">
              <button className="workflow-cancel" onClick={cancelWorkflow}>Cancel</button>
              <div className="workflow-action-right">
                <button className="workflow-secondary" onClick={saveCurrentStepAsDraft} disabled={busy}>{busy ? 'Saving…' : 'Save as Draft'}</button>
                <button className="workflow-secondary" onClick={() => setTab(tabs[Math.max(0, tabs.findIndex(([key]) => key === tab) - 1)][0])} disabled={busy || tab === tabs[0][0]}>Back</button>
                <button className="workflow-next" onClick={async () => {
                  if (tab === 'script') { await saveScript(); return; }
                  if (tab === 'voices') { if (!voiceReady) { setError('Complete your voice selection before continuing.'); return; } if (!await saveVoiceMappings()) return; }
                  setTab(tabs[Math.min(tabs.length - 1, tabs.findIndex(([key]) => key === tab) + 1)][0]);
                }} disabled={busy || tab === tabs[tabs.length - 1][0] || (tab === 'script' && !script.trim()) || (tab === 'voices' && !voiceReady)}>{tab === tabs[tabs.length - 1][0] ? 'Last step' : 'Next'} <span>→</span></button>
              </div>
            </div>
          </>}
          <footer className="page-footer"><span>Made for stories worth hearing.</span><span>SONORA STUDIO · LOCAL MVP</span></footer>
        </div>
      </section>
    </main>
  );
}
