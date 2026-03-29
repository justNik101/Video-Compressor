import React, { useState, useRef, useEffect } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import ffmpegWorkerUrl from '@ffmpeg/ffmpeg/worker?url';
import coreJsUrl from '@ffmpeg/core?url';
import coreWasmUrl from '@ffmpeg/core/wasm?url';
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
  });

  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadDeterminate, setDownloadDeterminate] = useState(true);
  const [downloadLabel, setDownloadLabel] = useState('INITIALIZING...');
  const [isIsolated, setIsIsolated] = useState(true);

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
      });

      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('FFmpeg load timeout (70s)')), 70000)
      );

      const loadPromise = ffmpeg.load(
        {
          classWorkerURL: ffmpegWorkerUrl,
          coreURL: coreJsUrl,
          wasmURL: coreWasmUrl,
        },
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

  // --- Handlers ---
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.type.startsWith('video/')) {
        setVideoFile(file);
        setCompressedUrl(null);
        setError(null);
        setProgress(0);

        // Get video duration
        const video = document.createElement('video');
        video.preload = 'metadata';
        video.onloadedmetadata = () => {
          setVideoDuration(video.duration);
          // Suggest a target size (e.g., 50% of original)
          const suggestedSize = Math.max(1, Math.round((file.size / (1024 * 1024)) * 0.5));
          setSettings(prev => ({ ...prev, targetSizeMB: suggestedSize }));
        };
        video.src = URL.createObjectURL(file);
      } else {
        setError('Please select a valid video file.');
      }
    }
  };

  const compressVideo = async () => {
    if (!ffmpeg || !videoFile) return;

    setCompressing(true);
    setError(null);
    setProgress(0);

    try {
      if (settings.mode === 'custom' && !videoDuration) {
        throw new Error('Video metadata not loaded. Please wait a moment and try again.');
      }
      const inputName = 'input.mp4';
      const outputName = 'output.mp4';

      await ffmpeg.writeFile(inputName, await fetchFile(videoFile));

      const args = ['-i', inputName];

      // Video filters: scale
      if (settings.scale !== 'original') {
        args.push('-vf', `scale=${settings.scale}:force_original_aspect_ratio=decrease`);
      }
      
      // Video codec
      args.push('-c:v', 'libx264');
      args.push('-pix_fmt', 'yuv420p');
      args.push('-preset', settings.preset);
      args.push('-movflags', '+faststart');

      if (settings.mode === 'custom' && videoDuration) {
        // Calculate bitrate for target size: Bitrate = (Size * 8) / Duration
        // Target size in bits = MB * 1024 * 1024 * 8
        const targetBits = settings.targetSizeMB * 1024 * 1024 * 8;
        const totalBitrate = targetBits / videoDuration;
        
        // Subtract audio bitrate (approx 128kbps)
        const videoBitrate = Math.max(100000, totalBitrate - 128000);
        
        args.push('-b:v', `${Math.round(videoBitrate)}`);
        args.push('-maxrate', `${Math.round(videoBitrate * 1.5)}`);
        args.push('-bufsize', `${Math.round(videoBitrate * 2)}`);
      } else {
        // Quality based modes
        let crf = settings.crf;
        if (settings.mode === 'small') crf = 32;
        if (settings.mode === 'medium') crf = 28;
        if (settings.mode === 'high') crf = 23;
        
        args.push('-crf', crf.toString());
      }

      // Audio settings
      args.push('-c:a', 'aac');
      args.push('-b:a', '128k');
      
      // Output
      args.push(outputName);

      await ffmpeg.exec(args);

      const data = await ffmpeg.readFile(outputName);
      // `data` can be backed by a SharedArrayBuffer; using the Uint8Array avoids BlobPart typing issues.
      const url = URL.createObjectURL(new Blob([data as Uint8Array], { type: 'video/mp4' }));
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
            <div className="text-xs font-mono text-emerald-600 bg-emerald-50 px-2 py-1 border border-emerald-200 rounded-sm">
              SYSTEM_READY
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
                <label className="group relative flex flex-col items-center justify-center border-2 border-dashed border-[#141414] rounded-lg p-12 cursor-pointer hover:bg-zinc-50 transition-all">
                  <input type="file" accept="video/*" className="hidden" onChange={handleFileChange} />
                  <div className="bg-[#141414] p-4 rounded-full mb-4 group-hover:scale-110 transition-transform">
                    <Upload className="w-8 h-8 text-[#E4E3E0]" />
                  </div>
                  <p className="text-lg font-bold mb-1">Click to upload or drag and drop</p>
                  <p className="text-sm opacity-60 font-mono">MP4, WebM, MOV (Max 50MB recommended)</p>
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
                      {settings.mode === 'custom' 
                        ? settings.targetSizeMB 
                        : Math.round((videoFile.size / (1024 * 1024)) * (settings.mode === 'small' ? 0.3 : settings.mode === 'medium' ? 0.5 : 0.8))}
                    </span>
                    <span className="text-xs font-mono font-bold">MB</span>
                    <span className="text-[10px] font-mono opacity-40 italic">
                      (~{settings.mode === 'small' ? '70' : settings.mode === 'medium' ? '50' : '20'}% reduction)
                    </span>
                  </div>
                </div>
              )}

              {/* Action Button */}
              <div className="pt-4">
                {compressing ? (
                  <div className="space-y-4">
                    <div className="flex justify-between items-end mb-1">
                      <span className="text-xs font-mono animate-pulse">COMPRESSING_DATA...</span>
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
