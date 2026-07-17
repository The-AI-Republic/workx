import type { InvokeArgs } from '@tauri-apps/api/core';

export interface VoiceSttStatus {
  configured: boolean;
  installed: boolean;
  target: string;
  componentVersion?: string;
  protocolVersion?: number;
  runtimePath?: string;
  modelPath?: string;
  manifestUrl?: string;
  error?: string;
}

export interface VoiceTranscriptionResult {
  text: string;
  language?: string;
  durationMs?: number;
  confidence?: number;
  source: string;
}

export function canUseBrowserVoiceCapture(): boolean {
  return typeof window !== 'undefined'
    && '__TAURI_INTERNALS__' in window
    && typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia
    && typeof MediaRecorder !== 'undefined';
}

async function invokeTauri<T>(command: string, args?: InvokeArgs): Promise<T> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    throw new Error('Voice input is only available in the desktop app.');
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

export async function getVoiceSttStatus(): Promise<VoiceSttStatus> {
  return invokeTauri<VoiceSttStatus>('voice_stt_status');
}

export async function ensureVoiceSttInstalled(): Promise<VoiceSttStatus> {
  const status = await getVoiceSttStatus();
  if (status.installed) {
    return status;
  }
  if (!status.configured) {
    throw new Error('Voice STT is not configured for this build.');
  }
  return invokeTauri<VoiceSttStatus>('install_voice_stt_component');
}

async function blobToBase64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read recorded audio.'));
    reader.readAsDataURL(blob);
  });
  const commaIndex = dataUrl.indexOf(',');
  return commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
}

export function preferredVoiceMimeType(): string | undefined {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

export async function transcribeAudioBlob(blob: Blob): Promise<VoiceTranscriptionResult> {
  await ensureVoiceSttInstalled();
  const audioBase64 = await blobToBase64(blob);
  return invokeTauri<VoiceTranscriptionResult>('transcribe_voice_audio', {
    audioBase64,
    mimeType: blob.type || undefined,
  });
}
