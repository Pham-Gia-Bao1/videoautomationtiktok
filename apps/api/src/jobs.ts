import { EventEmitter } from 'node:events';
import { AppError, ERROR_CODES, backoffDelayMs, recomputeBatchStatus } from '@podcast/core';
import type { AudioRecord, GenerationBatch, GenerationChunk, Transcription } from '@podcast/types';
import { createElevenLabsVideo, downloadElevenLabsVideo, generateDialogue, getElevenLabsVideo, transcribeAudio } from './elevenlabs';
import { mergeAudio, renderAudioVideo, renderVideoWithClips, resolveAudioPath, storeAudio, storeGeneratedVideo } from './media';
import { renderGhostEdit } from './ghost-editor';
import { id, now, readData, updateData } from './store';

export const studioEvents = new EventEmitter();

function publish(type: string, batchId: string, detail: Record<string, unknown> = {}) {
  studioEvents.emit(batchId, { type, batchId, ...detail, at: now() });
}

async function settleBatch(batchId: string): Promise<void> {
  await updateData((data) => {
    const batch = data.batches.find((item) => item.id === batchId);
    if (!batch) return;
    const chunks = data.chunks.filter((item) => item.batchId === batchId);
    const status = recomputeBatchStatus(chunks.map((item) => item.status));
    batch.status = status;
    batch.completedChunks = chunks.filter((item) => item.status === 'COMPLETED').length;
    batch.failedChunks = chunks.filter((item) => item.status === 'FAILED').length;
    if (['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'].includes(status)) batch.completedAt = now();
  });
  const batch = (await readData()).batches.find((item) => item.id === batchId);
  if (batch) publish('batch.updated', batchId, { batchStatus: batch.status });
}

async function generateChunk(batch: GenerationBatch, chunkId: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const chunk = (await readData()).chunks.find((item) => item.id === chunkId);
    if (!chunk || chunk.status === 'CANCELLED') return;
    await updateData((data) => {
      const current = data.chunks.find((item) => item.id === chunkId);
      if (current) current.status = 'RUNNING';
    });
    publish('chunk.updated', batch.id, { chunkId, chunkIndex: chunk.chunkIndex, status: 'RUNNING' });

    try {
      const result = await generateDialogue(chunk.payload);
      const audioId = id();
      const storagePath = await storeAudio(audioId, result.audio);
      const audio: AudioRecord = {
        id: audioId,
        episodeId: batch.episodeId,
        chunkId,
        kind: 'chunk',
        storagePath,
        mimeType: result.mimeType,
        durationSeconds: null,
        sizeBytes: result.audio.byteLength,
        outputFormat: chunk.payload.output_format ?? 'mp3_44100_128',
        metadata: { chunkIndex: chunk.chunkIndex },
        label: `${batch.label} — chunk ${chunk.chunkIndex}`,
        createdAt: now(),
      };
      await updateData((data) => {
        data.audios.push(audio);
        const current = data.chunks.find((item) => item.id === chunkId);
        if (current) {
          current.status = 'COMPLETED';
          current.audioId = audioId;
          current.completedAt = now();
          current.retryCount = attempt - 1;
          current.errorCode = null;
          current.errorMessage = null;
        }
      });
      publish('chunk.updated', batch.id, { chunkId, chunkIndex: chunk.chunkIndex, status: 'COMPLETED', audioId });
      return;
    } catch (error) {
      const appError = error instanceof AppError
        ? error
        : new AppError(ERROR_CODES.INTERNAL, 'Unexpected generation worker error.', 500);
      const retry = appError.retryable && attempt < 3;
      await updateData((data) => {
        const current = data.chunks.find((item) => item.id === chunkId);
        if (current) {
          current.status = retry ? 'QUEUED' : 'FAILED';
          current.retryCount = attempt;
          current.errorCode = appError.code;
          current.errorMessage = appError.message;
        }
      });
      publish('chunk.updated', batch.id, {
        chunkId, chunkIndex: chunk.chunkIndex, status: retry ? 'QUEUED' : 'FAILED', errorMessage: appError.message,
      });
      if (!retry) return;
      await new Promise((resolve) => setTimeout(resolve, backoffDelayMs(attempt)));
    }
  }
}

export function startGenerationBatch(batchId: string): void {
  void (async () => {
    const data = await readData();
    const batch = data.batches.find((item) => item.id === batchId);
    if (!batch) return;
    const pending = data.chunks.filter((item) => item.batchId === batchId && item.status === 'QUEUED');
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
      while (next < pending.length) {
        const index = next++;
        await generateChunk(batch, pending[index].id);
      }
    }));
    await settleBatch(batchId);
  })().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unexpected generation failure.';
    publish('batch.updated', batchId, { batchStatus: 'FAILED', errorMessage: message });
  });
}

export async function retryFailedChunks(batchId: string): Promise<string[]> {
  const retryIds = await updateData((data) => {
    const chunks = data.chunks.filter((item) => item.batchId === batchId && item.status === 'FAILED');
    for (const chunk of chunks) {
      chunk.status = 'QUEUED';
      chunk.retryCount = 0;
      chunk.errorCode = null;
      chunk.errorMessage = null;
      chunk.completedAt = null;
    }
    const batch = data.batches.find((item) => item.id === batchId);
    if (batch && chunks.length) {
      batch.status = 'QUEUED';
      batch.failedChunks = 0;
      batch.completedAt = null;
    }
    return chunks.map((item) => item.id);
  });
  if (retryIds.length) startGenerationBatch(batchId);
  return retryIds;
}

export async function mergeComposition(compositionId: string): Promise<void> {
  const data = await readData();
  const composition = data.compositions.find((item) => item.id === compositionId);
  if (!composition) throw new AppError(ERROR_CODES.NOT_FOUND, 'Composition not found.', 404);
  const items = data.compositionItems
    .filter((item) => item.compositionId === compositionId)
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((item) => {
      const audio = data.audios.find((candidate) => candidate.id === item.audioId);
      if (!audio || audio.deletedAt) throw new AppError(ERROR_CODES.NOT_FOUND, `Audio '${item.audioId}' not found.`, 404);
      return { ...item, storagePath: audio.storagePath };
    });

  await updateData((current) => {
    const record = current.compositions.find((item) => item.id === compositionId)!;
    record.status = 'MERGING';
    record.errorMessage = null;
    record.updatedAt = now();
  });
  try {
    const outputId = id();
    const merged = await mergeAudio(items, outputId);
    const output: AudioRecord = {
      id: outputId,
      episodeId: composition.episodeId,
      chunkId: null,
      kind: 'final',
      storagePath: merged.storagePath,
      mimeType: 'audio/mpeg',
      durationSeconds: merged.durationSeconds,
      sizeBytes: merged.sizeBytes,
      outputFormat: 'mp3_44100_128',
      metadata: { compositionId },
      label: `${composition.name} — final`,
      createdAt: now(),
    };
    await updateData((current) => {
      current.audios.push(output);
      const record = current.compositions.find((item) => item.id === compositionId)!;
      record.status = 'READY';
      record.outputAudioId = outputId;
      record.updatedAt = now();
      const episode = current.episodes.find((item) => item.id === record.episodeId);
      if (episode) {
        episode.status = 'ready';
        episode.updatedAt = now();
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Audio merge failed.';
    await updateData((current) => {
      const record = current.compositions.find((item) => item.id === compositionId);
      if (record) {
        record.status = 'FAILED';
        record.errorMessage = message;
        record.updatedAt = now();
      }
    });
    throw error;
  }
}

export function startVideoRender(videoId: string): void {
  void (async () => {
    const data = await readData();
    const video = data.videos.find((item) => item.id === videoId);
    const audio = video && data.audios.find((item) => item.id === video.audioId && !item.deletedAt);
    if (!video || !audio) return;

    try {
      let output: { storagePath: string; sizeBytes: number };
      if (!video.sourceMode || video.sourceMode === 'cover') {
        if (!video.coverStoragePath) throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'The cover image is missing.', 422);
        output = await renderAudioVideo(audio.storagePath, video.coverStoragePath, video.id, video.title, video.aspectRatio, video.resolution);
      } else if (video.sourceMode === 'ghost') {
        const selectedClips = (video.clipIds ?? [])
          .map((clipId) => data.videoClips.find((clip) => clip.id === clipId && clip.episodeId === video.episodeId));
        if (selectedClips.length === 0 || selectedClips.some((clip) => !clip)) {
          throw new AppError(ERROR_CODES.NOT_FOUND, 'One or more selected Ghost Editor source videos are unavailable.', 404);
        }
        const script = data.scripts.filter((item) => item.episodeId === video.episodeId)
          .sort((a, b) => b.version - a.version)[0];
        if (!script) throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Save a script for this episode before using Ghost Editor.', 422);
        let currentData = data;
        let transcription = video.transcriptionId
          ? currentData.transcriptions.find((item) => item.id === video.transcriptionId && item.status === 'COMPLETED')
          : currentData.transcriptions.find((item) => item.audioId === audio.id && item.status === 'COMPLETED');
        if (!transcription) {
          const transcriptionId = await transcribe(audio.id);
          currentData = await readData();
          transcription = currentData.transcriptions.find((item) => item.id === transcriptionId && item.status === 'COMPLETED');
          if (!transcription) throw new AppError(ERROR_CODES.ELEVENLABS_API_ERROR, 'Could not prepare word timings for the Ghost Editor reel.', 502);
          await updateData((current) => {
            const record = current.videos.find((item) => item.id === videoId);
            if (record) record.transcriptionId = transcriptionId;
          });
        }
        if (!video.ghostStyle) throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Choose a Ghost Editor style before rendering.', 422);
        const editEvents = currentData.editEvents.filter((event) => event.episodeVideoId === video.id);
        const ghostMusic = (video.musicTracks ?? []).map((track) => { const asset=currentData.musicAssets.find((item)=>item.id===track.musicId&&item.episodeId===video.episodeId); if(!asset)throw new AppError(ERROR_CODES.NOT_FOUND,'A selected background music file is unavailable.',404); return { ...track,storagePath:asset.storagePath,durationSeconds:asset.durationSeconds }; });
        const ghostEffects = editEvents.filter((event)=>event.enabled&&event.track==='sound-effect').map((event)=>{const asset=currentData.musicAssets.find((item)=>item.id===event.musicAssetId&&item.episodeId===video.episodeId);if(!asset)throw new AppError(ERROR_CODES.NOT_FOUND,'A selected sound effect file is unavailable.',404);return {storagePath:asset.storagePath,volume:event.volume,startSeconds:0,endSeconds:Math.min(asset.durationSeconds,event.endSeconds-event.startSeconds),outputStartSeconds:event.startSeconds,fadeInSeconds:.03,fadeOutSeconds:.12,durationSeconds:asset.durationSeconds};});
        output = await renderGhostEdit({
          audioStoragePath: audio.storagePath,
          clips: selectedClips as NonNullable<(typeof selectedClips)[number]>[],
          segments: transcription.segments,
          scriptText: script.rawText,
          videoId: video.id,
          title: video.title,
          aspectRatio: video.aspectRatio ?? '9:16',
          resolution: video.resolution ?? 1080,
          style: video.ghostStyle as import('./ghost-editor').GhostStyle,
          musicTracks: [...ghostMusic,...ghostEffects],
          voiceVolume: video.voiceVolume ?? 1,
          subtitleStyle: video.subtitleStyle,
          editEvents,
        });
      } else {
        let clipStoragePaths: string[];
        if (video.sourceMode === 'elevenlabs') {
          const prompt = video.prompt?.trim();
          if (!prompt) throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'A video prompt is required.', 422);
          let generation = await createElevenLabsVideo(prompt);
          await updateData((current) => {
            const record = current.videos.find((item) => item.id === videoId);
            if (record) record.generationId = generation.id;
          });
          const generationDeadline = Date.now() + Number(process.env.ELEVENLABS_VIDEO_TIMEOUT_MS ?? 1_200_000);
          while (generation.status === 'pending' || generation.status === 'generating') {
            if (Date.now() >= generationDeadline) {
              throw new AppError(ERROR_CODES.ELEVENLABS_TIMEOUT, 'ElevenLabs video generation exceeded its time limit.', 504);
            }
            await new Promise((resolve) => setTimeout(resolve, 3_000));
            generation = await getElevenLabsVideo(generation.id);
          }
          if (generation.status === 'failed') {
            throw new AppError(ERROR_CODES.ELEVENLABS_API_ERROR, `ElevenLabs video generation failed: ${generation.error_message}`, 502);
          }
          if (generation.status !== 'completed') {
            throw new AppError(ERROR_CODES.ELEVENLABS_API_ERROR, 'ElevenLabs video generation ended without a completed video.', 502);
          }
          if (generation.content_mime_type !== 'video/mp4') {
            throw new AppError(ERROR_CODES.ELEVENLABS_API_ERROR, 'ElevenLabs returned an unsupported video format.', 502);
          }
          const downloaded = await downloadElevenLabsVideo(generation.content_url);
          if (downloaded.mimeType !== 'video/mp4') {
            throw new AppError(ERROR_CODES.ELEVENLABS_API_ERROR, 'The generated video download was not an MP4 file.', 502);
          }
          const storedPath = await storeGeneratedVideo(video.id, downloaded.mimeType, downloaded.data);
          clipStoragePaths = [storedPath];
        } else {
          const selectedClips = (video.clipIds ?? [])
            .map((clipId) => data.videoClips.find((clip) => clip.id === clipId && clip.episodeId === video.episodeId));
          if (selectedClips.length === 0 || selectedClips.some((clip) => !clip)) {
            throw new AppError(ERROR_CODES.NOT_FOUND, 'One or more selected video clips are unavailable.', 404);
          }
          clipStoragePaths = selectedClips.map((clip) => clip!.storagePath);
        }

        const subtitle = video.subtitleId
          ? data.subtitles.find((item) => item.id === video.subtitleId)
          : undefined;
        if (video.subtitleId && (!subtitle || !['srt', 'vtt'].includes(subtitle.format))) {
          throw new AppError(ERROR_CODES.NOT_FOUND, 'The selected subtitle is unavailable.', 404);
        }
        const subtitleTranscription = subtitle && data.transcriptions.find((item) => item.id === subtitle.transcriptionId);
        const music = (video.musicTracks ?? []).map((track) => {
          const asset = data.musicAssets.find((item) => item.id === track.musicId && item.episodeId === video.episodeId);
          if (!asset) throw new AppError(ERROR_CODES.NOT_FOUND, 'One of the selected background music files is unavailable.', 404);
          return { ...track, storagePath: asset.storagePath, durationSeconds: asset.durationSeconds };
        });
        const editEvents = data.editEvents.filter((event) => event.episodeVideoId === video.id);
        const soundEffects = editEvents.filter((event) => event.enabled && event.track === 'sound-effect').map((event) => {
          const asset = data.musicAssets.find((item) => item.id === event.musicAssetId && item.episodeId === video.episodeId);
          if (!asset) throw new AppError(ERROR_CODES.NOT_FOUND, 'One of the selected sound effect files is unavailable.', 404);
          return { storagePath: asset.storagePath, volume: event.volume, startSeconds: 0, endSeconds: Math.min(asset.durationSeconds, event.endSeconds - event.startSeconds), outputStartSeconds: event.startSeconds, fadeInSeconds: 0.03, fadeOutSeconds: 0.12, durationSeconds: asset.durationSeconds };
        });
        output = await renderVideoWithClips(
          audio.storagePath,
          clipStoragePaths,
          subtitle?.content ?? null,
          subtitle?.format ?? null,
          video.id,
          video.title,
          video.aspectRatio,
          video.resolution,
          [...music, ...soundEffects],
          video.voiceVolume ?? 1,
          subtitleTranscription?.segments ?? [],
          video.subtitleStyle,
          editEvents,
        );
      }
      await updateData((current) => {
        const record = current.videos.find((item) => item.id === videoId);
        if (!record) return;
        record.status = 'READY';
        record.storagePath = output.storagePath;
        record.sizeBytes = output.sizeBytes;
        record.errorMessage = null;
        record.completedAt = now();
      });
    } catch (error) {
        const message = error instanceof AppError
          ? error.message
          : error instanceof Error ? error.message : 'Unexpected video rendering error.';
      await updateData((current) => {
        const record = current.videos.find((item) => item.id === videoId);
        if (!record) return;
        record.status = 'FAILED';
        record.errorMessage = message;
        record.completedAt = now();
      });
      console.error(`Video render ${videoId} failed:`, error);
    }
  })().catch((error: unknown) => {
    console.error(`Could not start video render ${videoId}:`, error);
  });
}

export async function recoverInterruptedVideoRenders(): Promise<void> {
  await updateData((data) => {
    for (const video of data.videos) {
      if (video.status === 'PROCESSING') {
        video.status = 'FAILED';
        video.errorMessage = 'Video rendering was interrupted when the API stopped. Start a new export to try again.';
        video.completedAt = now();
      }
    }
  });
}

export async function transcribe(audioId: string): Promise<string> {
  const data = await readData();
  const audio = data.audios.find((item) => item.id === audioId && !item.deletedAt);
  if (!audio) throw new AppError(ERROR_CODES.NOT_FOUND, 'Audio not found.', 404);
  const episode = data.episodes.find((item) => item.id === audio.episodeId);
  const transcriptionId = id();
  const transcription: Transcription = {
    id: transcriptionId,
    audioId,
    languageCode: episode?.languageCode ?? null,
    text: '',
    segments: [],
    status: 'RUNNING',
    provider: 'elevenlabs',
    errorMessage: null,
    createdAt: now(),
    completedAt: null,
  };
  await updateData((current) => current.transcriptions.push(transcription));
  try {
    const result = await transcribeAudio(await resolveAudioPath(audio.storagePath), transcription.languageCode);
    await updateData((current) => {
      const record = current.transcriptions.find((item) => item.id === transcriptionId)!;
      record.text = result.text;
      record.segments = result.segments;
      record.status = 'COMPLETED';
      record.completedAt = now();
    });
    return transcriptionId;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Transcription failed.';
    await updateData((current) => {
      const record = current.transcriptions.find((item) => item.id === transcriptionId);
      if (record) {
        record.status = 'FAILED';
        record.errorMessage = message;
        record.completedAt = now();
      }
    });
    throw error;
  }
}
