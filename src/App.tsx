import React, { useState, useRef, useEffect } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import coreJsUrl from '@ffmpeg/core?url';
import coreWasmUrl from '@ffmpeg/core/wasm?url';
import coreMtJsUrl from '@ffmpeg/core-mt?url';
import coreMtWasmUrl from '@ffmpeg/core-mt/wasm?url';
// The multithreading worker is served from the local public dist path because the npm package does not officially export it to Vite
const workerMtUrl = import.meta.env.BASE_URL + 'ffmpeg-core-mt.worker.js';

import { 
  Upload, 
  Settings, 
  Download, 
  Video, 
  CheckCircle2, 
  AlertCircle, 
  Loader2,
  X,
  FileVideo,
  Zap
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// --- Types ---
type CompressionMode = 'small' | 'medium' | 'high' | 'custom';

interface CompressionSettings {
  mode: CompressionMode;
  scale: string;
  crf: number;
  preset: string;
  targetSizeMB: number;
  trimStart: number;
  trimEnd: number;
  removeAudio: boolean;
  outputFormat: 'mp4' | 'webm' | 'mp3';
}

export default function App() {
  const [ffmpeg, setFfmpeg] = useState<FFmpeg | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [compressing, setCompressing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [compressedUrl, setCompressedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<CompressionSettings>({
    mode: 'medium',
    scale: 'original',
    crf: 28,
    preset: 'medium',
    targetSizeMB: 10,
    trimStart: 0,
    trimEnd: 0,
    removeAudio: false,
    outputFormat: 'mp4',
  });

  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadDeterminate, setDownloadDeterminate] = useState(true);
  const [downloadLabel, setDownloadLabel] = useState('INITIALIZING...');
  const [isIsolated, setIsIsolated] = useState(true);
  const [isMultiThreaded, setIsMultiThreaded] = useState(false);
  const [compressionStartTime, setCompressionStartTime] = useState<number | null>(null);
  const [eta, setEta] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const ffmpegRef = useRef<FFmpeg | null>(null);

  // --- FFmpeg Initialization ---
  useEffect(() => {
    setIsIsolated(window.crossOriginIsolated);
    const ac = new AbortController();
    loadFFmpeg(ac.signal);
    return () => ac.abort();
  }, []);

  const loadFFmpeg = async (signal?: AbortSignal) => {
    setLoaded(false);
    setError(null);
    setDownloadProgress(0);
    setDownloadDeterminate(false);
    setDownloadLabel('STARTING_ENGINE...');

    try {
      const ffmpeg = new FFmpeg();
      ffmpegRef.current = ffmpeg;

      ffmpeg.on('log', ({ message }) => {
        console.log('[FFmpeg Log]', message);
      });

      ffmpeg.on('progress', ({ progress: p }) => {
        setProgress(Math.round(p * 100));
        setCompressionStartTime((startTime) => {
          if (startTime && p > 0 && p < 1) {
            const elapsed = Date.now() - startTime;
            const totalTime = elapsed / p;
            const remaining = totalTime - elapsed;
            setEta(remaining);
          } else if (p === 1) {
            setEta(0);
          }
          return startTime;
        });
      });

      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('FFmpeg load timeout (70s)')), 70000)
      );

      const supportsMT = typeof SharedArrayBuffer !== 'undefined' && (navigator.hardwareConcurrency || 0) > 1;
      setIsMultiThreaded(supportsMT);

      const loadPromise = ffmpeg.load(
        supportsMT
          ? { coreURL: coreMtJsUrl, wasmURL: coreMtWasmUrl, workerURL: workerMtUrl }
          : { coreURL: coreJsUrl, wasmURL: coreWasmUrl },
        { signal },
      );

      await Promise.race([loadPromise, timeoutPromise]);

      if (signal?.aborted) return;

      setFfmpeg(ffmpeg);
      setLoaded(true);
      setDownloadDeterminate(true);
      setDownloadProgress(100);
      setDownloadLabel('READY');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (signal?.aborted) return;
      console.error('Failed to load FFmpeg:', err);
      setError(
        err instanceof Error && err.message.includes('timeout')
          ? 'Loading timed out (70s). This usually happens due to browser security restrictions in the preview iframe.'
          : 'Could not initialize video processor. This environment restricts the high-performance engine.'
      );
    }
  };

  const processFile = (file: File) => {
    if (file.type.startsWith('video/')) {
      setVideoFile(file);
      setCompressedUrl(null);
      setError(null);
      setProgress(0);

      const video = document.createElement('video');
      video.preload = 'metadata';
      video.onloadedmetadata = () => {
        setVideoDuration(video.duration);
        const suggestedSize = Math.max(1, Math.round((file.size / (1024 * 1024)) * 0.5));
        setSettings(prev => ({ 
          ...prev, 
          targetSizeMB: suggestedSize, 
          trimEnd: Math.round(video.duration), 
          trimStart: 0 
        }));
      };
      video.src = URL.createObjectURL(file);
    } else {
      setError('Please select a valid video file.');
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  };

  const compressVideo = async () => {
    if (!ffmpeg || !videoFile) return;

    setCompressing(true);
    setError(null);
    setProgress(0);
    setCompressionStartTime(Date.now());
    setEta(null);

    try {
      if (settings.mode === 'custom' && !videoDuration) {
        throw new Error('Video metadata not loaded. Please wait a moment and try again.');
      }
      const inputName = 'input.mp4';
      const outputName = `output.${settings.outputFormat}`;

      await ffmpeg.writeFile(inputName, await fetchFile(videoFile));

      const args = [];
      if (settings.trimStart > 0) args.push('-ss', settings.trimStart.toString());
      if (settings.trimEnd > 0 && videoDuration && settings.trimEnd < videoDuration) args.push('-to', settings.trimEnd.toString());
      args.push('-i', inputName);

      if (settings.outputFormat !== 'mp3') {
        if (settings.scale !== 'original') {
          args.push('-vf', `scale=${settings.scale}:force_original_aspect_ratio=decrease`);
        }
        
        if (settings.outputFormat === 'webm') {
          args.push('-c:v', 'libvpx-vp9');
          args.push('-row-mt', '1');
        } else {
          args.push('-c:v', 'libx264');
          args.push('-pix_fmt', 'yuv420p');
          args.push('-preset', settings.preset);
          args.push('-movflags', '+faststart');
        }

        if (settings.mode === 'custom' && videoDuration) {
          const targetBits = settings.targetSizeMB * 1024 * 1024 * 8;
          const totalBitrate = targetBits / videoDuration;
          const audioBitrate = settings.removeAudio ? 0 : 128000;
          const videoBitrate = Math.max(100000, totalBitrate - audioBitrate);
          
          args.push('-b:v', `${Math.round(videoBitrate)}`);
          args.push('-maxrate', `${Math.round(videoBitrate * 1.5)}`);
          args.push('-bufsize', `${Math.round(videoBitrate * 2)}`);
        } else {
          let crf = settings.crf;
          if (settings.mode === 'small') crf = 32;
          if (settings.mode === 'medium') crf = 28;
          if (settings.mode === 'high') crf = 23;
          args.push('-crf', crf.toString());
        }
      }

      if (settings.outputFormat === 'mp3') {
        args.push('-q:a', '0', '-map', 'a');
      } else if (settings.removeAudio) {
        args.push('-an');
      } else {
        args.push('-c:a', settings.outputFormat === 'webm' ? 'libopus' : 'aac');
        args.push('-b:a', '128k');
      }

      args.push(outputName);

      await ffmpeg.exec(args);

      const data = await ffmpeg.readFile(outputName);
      
      let mimeType = 'video/mp4';
      if (settings.outputFormat === 'webm') mimeType = 'video/webm';
      if (settings.outputFormat === 'mp3') mimeType = 'audio/mp3';
      
      const url = URL.createObjectURL(new Blob([data as Uint8Array], { type: mimeType }));
      setCompressedUrl(url);
    } catch (err) {
      console.error('Compression error:', err);
      setError('An error occurred during compression. Try different settings or a smaller file.');
    } finally {
      setCompressing(false);
    }
  };

  const reset = () => {
    setVideoFile(null);
    setVideoDuration(null);
    setCompressedUrl(null);
    setProgress(0);
    setError(null);
  };

  // --- UI Components ---
  return (
    <div className="min-h-screen bg-[#E4E3E0] text-[#141414] font-sans selection:bg-[#141414] selection:text-[#E4E3E0]">
      {/* Header */}
      <header className="border-b border-[#141414] p-6 flex justify-between items-center">
        <div className="flex items-center gap-3">
          <div className="bg-[#141414] p-2 rounded-sm">
            <Zap className="w-6 h-6 text-[#E4E3E0]" />
          </div>
          <h1 className="text-2xl font-bold tracking-tighter uppercase italic font-serif">
            Video Compressor <span className="not-italic font-sans opacity-50">v1.0</span>
          </h1>
        </div>
        <div className="flex items-center gap-4">
          {!loaded && !error && (
            <div className="flex items-center gap-3 text-xs font-mono">
              <div className="flex flex-col items-end">
                <span className="opacity-60">{downloadLabel}</span>
                <span className="font-bold">
                  {downloadDeterminate ? `${downloadProgress}%` : '…'}
                </span>
              </div>
              <div className="w-24 h-2 bg-zinc-200 rounded-full overflow-hidden border border-[#141414]/10 relative">
                {downloadDeterminate ? (
                  <motion.div 
                    className="h-full bg-[#141414]" 
                    initial={{ width: 0 }}
                    animate={{ width: `${downloadProgress}%` }}
                  />
                ) : (
                  <motion.div
                    className="h-full bg-[#141414]"
                    initial={{ width: '35%' }}
                    animate={{ width: ['35%', '72%', '35%'], opacity: [0.55, 1, 0.55] }}
                    transition={{ repeat: Infinity, duration: 1.35, ease: 'easeInOut' }}
                  />
                )}
              </div>
            </div>
          )}
          {loaded && (
            <div className="flex gap-2">
              {isMultiThreaded ? (
                <div className="text-xs font-mono text-emerald-600 bg-emerald-50 px-2 py-1 border border-emerald-200 rounded-sm">
                  MT_ENGINE_ACTIVE
                </div>
              ) : (
                <div className="text-xs font-mono text-amber-600 bg-amber-50 px-2 py-1 border border-amber-200 rounded-sm">
                  COMPATIBILITY_MODE
                </div>
              )}
            </div>
          )}
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Column: Upload & Preview */}
        <div className="lg:col-span-7 space-y-6">
          <section className="bg-white border border-[#141414] shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] overflow-hidden">
            <div className="border-b border-[#141414] p-3 bg-[#141414] text-[#E4E3E0] flex justify-between items-center">
              <span className="text-xs font-mono uppercase tracking-widest">01_Source_Media</span>
              {videoFile && (
                <button onClick={reset} className="hover:text-red-400 transition-colors">
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
            
            <div className="p-8">
              {!videoFile ? (
                <label 
                  onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                  onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
                  onDrop={(e) => {
                    e.preventDefault();
                    setIsDragging(false);
                    const file = e.dataTransfer.files?.[0];
                    if (file) processFile(file);
                  }}
                  className={`group relative flex flex-col items-center justify-center border-2 border-dashed ${isDragging ? 'border-emerald-500 bg-emerald-50' : 'border-[#141414] hover:bg-zinc-50'} rounded-lg p-12 cursor-pointer transition-all`}
                >
                  <input type="file" accept="video/*" className="hidden" onChange={handleFileChange} />
                  <div className={`${isDragging ? 'bg-emerald-500' : 'bg-[#141414]'} p-4 rounded-full mb-4 group-hover:scale-110 transition-transform`}>
                    <Upload className="w-8 h-8 text-[#E4E3E0]" />
                  </div>
                  <p className="text-lg font-bold mb-1">{isDragging ? 'Drop video here' : 'Click to upload or drag and drop'}</p>
                  <p className="text-sm opacity-60 font-mono">MP4, WebM, MOV</p>
                </label>
              ) : (
                <div className="space-y-4">
                  <div className="aspect-video bg-black rounded-lg overflow-hidden border border-[#141414] relative group">
                    <video 
                      src={URL.createObjectURL(videoFile)} 
                      controls 
                      className="w-full h-full object-contain"
                    />
                    <div className="absolute top-4 left-4 bg-[#141414]/80 text-white px-3 py-1 rounded-full text-xs font-mono backdrop-blur-sm">
                      {videoFile.name} ({(videoFile.size / (1024 * 1024)).toFixed(2)} MB)
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>

          {compressedUrl && (
            <motion.section 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-emerald-50 border border-emerald-600 shadow-[4px_4px_0px_0px_rgba(5,150,105,1)] overflow-hidden"
            >
              <div className="border-b border-emerald-600 p-3 bg-emerald-600 text-white flex justify-between items-center">
                <span className="text-xs font-mono uppercase tracking-widest">03_Output_Result</span>
                <CheckCircle2 className="w-4 h-4" />
              </div>
              <div className="p-8 space-y-4">
                <div className="aspect-video bg-black rounded-lg overflow-hidden border border-emerald-600">
                  <video src={compressedUrl} controls className="w-full h-full object-contain" />
                </div>
                <div className="flex gap-4">
                  <a 
                    href={compressedUrl} 
                    download={`compressed_${videoFile?.name}`}
                    className="flex-1 bg-emerald-600 text-white py-4 px-6 rounded-sm font-bold flex items-center justify-center gap-2 hover:bg-emerald-700 transition-colors shadow-[2px_2px_0px_0px_rgba(20,20,20,1)]"
                  >
                    <Download className="w-5 h-5" />
                    DOWNLOAD_COMPRESSED_FILE
                  </a>
                </div>
              </div>
            </motion.section>
          )}
        </div>

        {/* Right Column: Settings & Controls */}
        <div className="lg:col-span-5 space-y-6">
          <section className="bg-white border border-[#141414] shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] overflow-hidden">
            <div className="border-b border-[#141414] p-3 bg-[#141414] text-[#E4E3E0] flex justify-between items-center">
              <span className="text-xs font-mono uppercase tracking-widest">02_Compression_Config</span>
              <div className="flex gap-2">
                <button 
                  onClick={() => setSettings({
                    mode: 'medium',
                    scale: 'original',
                    crf: 28,
                    preset: 'medium',
                    targetSizeMB: 10,
                  })}
                  className="text-[10px] font-mono uppercase opacity-60 hover:opacity-100 transition-opacity"
                >
                  RESET
                </button>
                <Settings className="w-4 h-4" />
              </div>
            </div>
            
            <div className="p-6 space-y-8">
              {/* Compression Mode */}
              <div className="space-y-3">
                <label className="text-xs font-mono uppercase opacity-50 block italic font-serif">Compression_Mode</label>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { label: 'Small File', value: 'small', desc: 'Lower quality' },
                    { label: 'Medium', value: 'medium', desc: 'Balanced' },
                    { label: 'High Quality', value: 'high', desc: 'Best visual' },
                    { label: 'Target Size', value: 'custom', desc: 'Specific MB' },
                  ].map((mode) => (
                    <button
                      key={mode.value}
                      onClick={() => setSettings({ ...settings, mode: mode.value as CompressionMode })}
                      className={`p-3 text-left border transition-all ${
                        settings.mode === mode.value 
                          ? 'bg-[#141414] text-[#E4E3E0] border-[#141414]' 
                          : 'border-zinc-200 hover:border-[#141414]'
                      }`}
                    >
                      <div className="text-xs font-bold uppercase">{mode.label}</div>
                      <div className="text-[10px] opacity-60 font-mono">{mode.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Target Size Input (Custom Mode Only) */}
              <AnimatePresence>
                {settings.mode === 'custom' && (
                  <motion.div 
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="space-y-3 overflow-hidden"
                  >
                    <div className="flex justify-between items-end">
                      <label className="text-xs font-mono uppercase opacity-50 block italic font-serif">Target_Size (MB)</label>
                      <span className="text-sm font-mono font-bold">{settings.targetSizeMB} MB</span>
                    </div>
                    <input 
                      type="range" 
                      min="1" 
                      max={videoFile ? Math.round(videoFile.size / (1024 * 1024)) : 100} 
                      step="1"
                      value={settings.targetSizeMB}
                      onChange={(e) => setSettings({ ...settings, targetSizeMB: parseInt(e.target.value) })}
                      className="w-full h-2 bg-zinc-200 rounded-lg appearance-none cursor-pointer accent-[#141414]"
                    />
                    <div className="flex justify-between text-[10px] font-mono opacity-40">
                      <span>1 MB</span>
                      <span>ORIGINAL_SIZE</span>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Resolution */}
              <div className="space-y-3">
                <label className="text-xs font-mono uppercase opacity-50 block italic font-serif">Target_Resolution</label>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { label: 'Keep Original', value: 'original' },
                    { label: '720p (HD)', value: '1280:720' },
                    { label: '480p (SD)', value: '854:480' },
                    { label: '360p', value: '640:360' },
                  ].map((res) => (
                    <button
                      key={res.value}
                      onClick={() => setSettings({ ...settings, scale: res.value })}
                      className={`p-3 text-sm font-mono border transition-all ${
                        settings.scale === res.value 
                          ? 'bg-[#141414] text-[#E4E3E0] border-[#141414]' 
                          : 'border-zinc-200 hover:border-[#141414]'
                      }`}
                    >
                      {res.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Preset */}
              <div className="space-y-3">
                <label className="text-xs font-mono uppercase opacity-50 block italic font-serif">Encoding_Speed</label>
                <div className="flex gap-2">
                  {['ultrafast', 'medium', 'veryslow'].map((p) => (
                    <button
                      key={p}
                      onClick={() => setSettings({ ...settings, preset: p })}
                      className={`flex-1 p-2 text-[10px] font-mono border uppercase tracking-tighter transition-all ${
                        settings.preset === p 
                          ? 'bg-[#141414] text-[#E4E3E0] border-[#141414]' 
                          : 'border-zinc-200 hover:border-[#141414]'
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>

              {/* Output Format & Audio */}
              <div className="space-y-3">
                <div className="flex justify-between">
                  <label className="text-xs font-mono uppercase opacity-50 block italic font-serif">Output_Format</label>
                  <label className="text-xs font-mono flex items-center gap-2 cursor-pointer">
                    <input 
                      type="checkbox" 
                      checked={settings.removeAudio} 
                      onChange={(e) => setSettings({ ...settings, removeAudio: e.target.checked })} 
                      className="accent-[#141414]"
                    />
                    <span className="opacity-70">Mute / Remove Audio</span>
                  </label>
                </div>
                <div className="flex gap-2">
                  {[{ id: 'mp4', label: 'MP4' }, { id: 'webm', label: 'WebM' }, { id: 'mp3', label: 'MP3' }].map((f) => (
                    <button
                      key={f.id}
                      onClick={() => setSettings({ ...settings, outputFormat: f.id as any })}
                      className={`flex-1 p-2 text-[10px] font-mono border uppercase tracking-tighter transition-all ${
                        settings.outputFormat === f.id 
                          ? 'bg-[#141414] text-[#E4E3E0] border-[#141414]' 
                          : 'border-zinc-200 hover:border-[#141414]'
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Trimming */}
              {videoFile && videoDuration && (
                <div className="space-y-3">
                  <label className="text-xs font-mono uppercase opacity-50 block italic font-serif">Trim_Video (Seconds)</label>
                  <div className="flex items-center gap-4">
                    <div className="flex-1 space-y-1">
                      <div className="text-[10px] font-mono opacity-60">Start Time</div>
                      <input 
                        type="number" 
                        min="0" 
                        max={settings.trimEnd || videoDuration}
                        value={settings.trimStart}
                        onChange={(e) => setSettings({ ...settings, trimStart: parseInt(e.target.value) || 0 })}
                        className="w-full bg-zinc-50 border border-zinc-200 p-2 text-sm font-mono"
                      />
                    </div>
                    <div className="flex-1 space-y-1">
                      <div className="text-[10px] font-mono opacity-60">End Time</div>
                      <input 
                        type="number" 
                        min={settings.trimStart} 
                        max={Math.round(videoDuration)}
                        value={settings.trimEnd}
                        onChange={(e) => setSettings({ ...settings, trimEnd: parseInt(e.target.value) || Math.round(videoDuration) })}
                        className="w-full bg-zinc-50 border border-zinc-200 p-2 text-sm font-mono"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Estimated Size */}
              {videoFile && (
                <div className="p-4 bg-zinc-50 border border-zinc-200 rounded-sm space-y-3">
                  <div className="flex justify-between items-center text-[10px] font-mono uppercase opacity-60">
                    <span>Source_Size</span>
                    <span>{(videoFile.size / (1024 * 1024)).toFixed(2)} MB</span>
                  </div>
                  <div className="h-px bg-zinc-200" />
                  <div className="flex justify-between items-center text-[10px] font-mono uppercase opacity-60 mb-2">
                    <span>Estimated_Output</span>
                    <Zap className="w-3 h-3" />
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-2xl font-bold font-mono">
                      {(() => {
                        if (settings.mode === 'custom') return settings.targetSizeMB;
                        let base = (videoFile.size / (1024 * 1024));
                        if (videoDuration && settings.trimEnd > settings.trimStart) {
                          base *= (settings.trimEnd - settings.trimStart) / videoDuration;
                        }
                        if (settings.removeAudio) base *= 0.9;
                        if (settings.scale === '1280:720') base *= 0.75;
                        if (settings.scale === '854:480') base *= 0.5;
                        if (settings.scale === '640:360') base *= 0.35;
                        
                        let mult = 0.5;
                        if (settings.mode === 'small') mult = 0.3;
                        if (settings.mode === 'high') mult = 0.8;
                        
                        return Math.max(0.1, Math.round(base * mult * 10) / 10);
                      })()}
                    </span>
                    <span className="text-xs font-mono font-bold">MB</span>
                    <span className="text-[10px] font-mono opacity-40 italic">
                       (Estimated based on selected filters)
                    </span>
                  </div>
                </div>
              )}

              {/* Action Button */}
              <div className="pt-4">
                {compressing ? (
                  <div className="space-y-4">
                    <div className="flex justify-between items-end mb-1">
                      <span className="text-xs font-mono animate-pulse">
                        {eta !== null ? `ETA: ${Math.max(0, Math.round(eta / 1000))}s` : 'STARTING_ENGINE...'}
                      </span>
                      <span className="text-xl font-bold font-mono">{progress}%</span>
                    </div>
                    <div className="w-full h-4 bg-zinc-100 border border-[#141414] overflow-hidden">
                      <motion.div 
                        className="h-full bg-[#141414]" 
                        initial={{ width: 0 }}
                        animate={{ width: `${progress}%` }}
                      />
                    </div>
                    <p className="text-[10px] font-mono opacity-50 text-center uppercase">
                      Please do not close this tab. Processing happens locally in your browser.
                    </p>
                  </div>
                ) : (
                  <button
                    disabled={!videoFile || !loaded}
                    onClick={compressVideo}
                    className={`w-full py-6 px-8 rounded-sm font-bold text-lg flex items-center justify-center gap-3 transition-all shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none ${
                      !videoFile || !loaded
                        ? 'bg-zinc-100 text-zinc-400 border-zinc-200 cursor-not-allowed shadow-none'
                        : 'bg-[#141414] text-[#E4E3E0] border-[#141414] hover:bg-zinc-800'
                    }`}
                  >
                    {loaded ? (
                      <>
                        <Video className="w-6 h-6" />
                        START_COMPRESSION
                      </>
                    ) : (
                      <>
                        <Loader2 className="w-6 h-6 animate-spin" />
                        LOADING_ENGINE...
                      </>
                    )}
                  </button>
                )}
              </div>

              {error && (
                <div className="space-y-4">
                  <div className="p-4 bg-red-50 border border-red-200 text-red-600 rounded-sm flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                    <div className="text-xs font-mono uppercase leading-relaxed">
                      {error}
                    </div>
                  </div>
                  
                  {!isIsolated && (
                    <div className="p-4 bg-amber-50 border border-amber-200 text-amber-700 rounded-sm space-y-3">
                      <div className="flex items-center gap-2 text-xs font-bold uppercase">
                        <Zap className="w-4 h-4" />
                        Compatibility_Fix_Required
                      </div>
                      <p className="text-[10px] font-mono leading-relaxed">
                        The video engine requires "Cross-Origin Isolation" which is often blocked in iframes. Opening the app in a new tab will enable full performance.
                      </p>
                      <button 
                        onClick={() => window.open(window.location.href, '_blank')}
                        className="w-full py-2 bg-amber-600 text-white text-[10px] font-bold uppercase rounded-sm hover:bg-amber-700 transition-colors"
                      >
                        OPEN_IN_NEW_TAB
                      </button>
                    </div>
                  )}

                  <button 
                    onClick={loadFFmpeg}
                    className="w-full py-2 border border-[#141414] text-[10px] font-bold uppercase hover:bg-zinc-100 transition-colors"
                  >
                    RETRY_INITIALIZATION
                  </button>
                </div>
              )}
            </div>
          </section>

          {/* Info Card */}
          <section className="p-6 border border-[#141414] bg-zinc-50 rounded-sm space-y-4">
            <h3 className="text-xs font-mono font-bold uppercase tracking-widest flex items-center gap-2">
              <FileVideo className="w-4 h-4" />
              Processing_Details
            </h3>
            <ul className="text-[11px] font-mono space-y-2 opacity-70">
              <li className="flex justify-between">
                <span>ENGINE:</span>
                <span className="font-bold">FFMPEG.WASM_V0.12</span>
              </li>
              <li className="flex justify-between">
                <span>CODEC:</span>
                <span className="font-bold">LIBX264 (H.264)</span>
              </li>
              <li className="flex justify-between">
                <span>PRIVACY:</span>
                <span className="font-bold">100%_CLIENT_SIDE</span>
              </li>
              <li className="pt-2 border-t border-zinc-200 leading-relaxed">
                Your video never leaves your computer. All processing is done locally using WebAssembly.
              </li>
            </ul>
          </section>
        </div>
      </main>

      {/* Footer */}
      <footer className="max-w-6xl mx-auto p-6 mt-12 border-t border-[#141414]/10 flex flex-col md:flex-row justify-between items-center gap-4 text-[10px] font-mono opacity-40 uppercase tracking-[0.2em]">
        <div>© 2026 VIDEO_COMPRESSOR_PRO // ALL_RIGHTS_RESERVED</div>
        <div className="flex gap-6">
          <span>SECURE_ENCRYPTION</span>
          <span>LOCAL_STORAGE_ONLY</span>
          <span>WASM_POWERED</span>
        </div>
      </footer>
    </div>
  );
}
