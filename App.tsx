
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { PanelTab, Note, ConflictItem, User, RejectedItem, DocketStatus, StickyNote, ChatMessage } from './types';
import { ICONS } from './constants';
import { analyzeConflicts, analyzeDocketProgress, chatWithSearch } from './services/geminiService';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';

// --- Encoding/Decoding for Live API ---
function encode(bytes: Uint8Array) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function decode(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i);
  return bytes;
}

async function decodeAudioData(data: Uint8Array, ctx: AudioContext, sampleRate: number, numChannels: number): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);
  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
  }
  return buffer;
}

const App: React.FC = () => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [activeTab, setActiveTab] = useState<PanelTab>(PanelTab.NOTEPAD);
  const [isMinimized, setIsMinimized] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const [stickyNotes, setStickyNotes] = useState<StickyNote[]>([]);
  const [conflicts, setConflicts] = useState<ConflictItem[]>([]);
  const [rejectedItems, setRejectedItems] = useState<RejectedItem[]>([]);
  const [showRejected, setShowRejected] = useState(false);
  const [docketStatus, setDocketStatus] = useState<DocketStatus>({ percentComplete: 0, requiredActions: [], currentStage: 'Initial Discovery' });
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [integrityStatus, setIntegrityStatus] = useState<Record<string, boolean>>({});
  const [globalSanitizeToggle, setGlobalSanitizeToggle] = useState(false);
  const [timelineZoom, setTimelineZoom] = useState(2); 

  // --- Fix: Define panelSize based on minimized state ---
  const panelSize = useMemo(() => ({
    width: isMinimized ? '280px' : '480px',
    height: isMinimized ? '48px' : '820px'
  }), [isMinimized]);

  // Chat State
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isChatLoading, setIsChatLoading] = useState(false);

  // Live API State
  const [isLiveActive, setIsLiveActive] = useState(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const liveSessionRef = useRef<any>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef(new Set<AudioBufferSourceNode>());

  useEffect(() => {
    const saved = localStorage.getItem('prose_notes');
    if (saved) setNotes(JSON.parse(saved));
    const savedStickies = localStorage.getItem('prose_stickies');
    if (savedStickies) setStickyNotes(JSON.parse(savedStickies));
    setCurrentUser({username: 'Counsel', id: '1'});
  }, []);

  useEffect(() => {
    localStorage.setItem('prose_notes', JSON.stringify(notes));
    verifyAllNotes();
  }, [notes]);

  const generateHash = async (content: string) => {
    const msgBuffer = new TextEncoder().encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', hashBuffer);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  };

  const verifyAllNotes = async () => {
    const status: Record<string, boolean> = {};
    for (const note of notes) {
      const currentHash = await generateHash(note.isSanitized ? note.content : note.rawContent);
      status[note.id] = currentHash === note.hash;
    }
    setIntegrityStatus(status);
  };

  const addNote = async (content: string, type: Note['type'], fileName?: string, lane: Note['lane'] = 'Neutral') => {
    // Supported types validation
    const supportedExtensions = ['.txt', '.pdf', '.docx', '.csv', '.json', '.msg'];
    if (fileName && !supportedExtensions.some(ext => fileName.toLowerCase().endsWith(ext))) {
      setRejectedItems(prev => [{ name: fileName, reason: 'Invalid File Type', timestamp: Date.now() }, ...prev]);
      return;
    }

    const raw = content;
    const hash = await generateHash(raw);
    if (notes.find(n => n.hash === hash)) {
      setRejectedItems(prev => [{ name: fileName || 'Text', reason: 'Duplicate Content', timestamp: Date.now() }, ...prev]);
      return;
    }

    const note: Note = {
      id: Math.random().toString(36).substr(2, 9),
      content: raw,
      rawContent: raw,
      timestamp: Date.now(),
      lastModified: Date.now(),
      type,
      fileName,
      hash,
      lane,
      confidence: 0.8,
      isSanitized: false,
      revisions: []
    };
    setNotes(prev => [note, ...prev]);
  };

  const updateConfidence = (id: string, val: number) => {
    setNotes(prev => prev.map(n => n.id === id ? { ...n, confidence: val } : n));
  };

  const startLiveSession = async () => {
    if (isLiveActive) {
      liveSessionRef.current?.close();
      setIsLiveActive(false);
      return;
    }

    // Creating a fresh instance for the live session as per guidelines
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY as string });
    const inputCtx = new AudioContext({ sampleRate: 16000 });
    const outputCtx = new AudioContext({ sampleRate: 24000 });
    audioContextRef.current = outputCtx;

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    const sessionPromise = ai.live.connect({
      model: 'gemini-2.5-flash-native-audio-preview-12-2025',
      callbacks: {
        onopen: () => {
          setIsLiveActive(true);
          const source = inputCtx.createMediaStreamSource(stream);
          const processor = inputCtx.createScriptProcessor(4096, 1, 1);
          processor.onaudioprocess = (e) => {
            const inputData = e.inputBuffer.getChannelData(0);
            const int16 = new Int16Array(inputData.length);
            for (let i = 0; i < inputData.length; i++) int16[i] = inputData[i] * 32768;
            const pcmBlob = { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' };
            // Using sessionPromise to ensure data is sent to the resolved session
            sessionPromise.then(s => s.sendRealtimeInput({ media: pcmBlob }));
          };
          source.connect(processor);
          processor.connect(inputCtx.destination);
        },
        onmessage: async (msg: LiveServerMessage) => {
          const audio = msg.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
          if (audio) {
            nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputCtx.currentTime);
            // Using manual PCM decoding logic as required
            const buffer = await decodeAudioData(decode(audio), outputCtx, 24000, 1);
            const source = outputCtx.createBufferSource();
            source.buffer = buffer;
            source.connect(outputCtx.destination);
            source.start(nextStartTimeRef.current);
            nextStartTimeRef.current += buffer.duration;
            sourcesRef.current.add(source);
          }
          if (msg.serverContent?.interrupted) {
            sourcesRef.current.forEach(s => s.stop());
            sourcesRef.current.clear();
            nextStartTimeRef.current = 0;
          }
        },
        onclose: () => setIsLiveActive(false),
        onerror: () => setIsLiveActive(false),
      },
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } } }
      }
    });
    liveSessionRef.current = await sessionPromise;
  };

  const handleChat = async () => {
    if (!chatInput.trim()) return;
    const userMsg: ChatMessage = { role: 'user', text: chatInput };
    setChatMessages(prev => [...prev, userMsg]);
    setChatInput('');
    setIsChatLoading(true);

    try {
      const history = chatMessages.map(m => ({ role: m.role, parts: [{ text: m.text }] }));
      const res = await chatWithSearch(chatInput, history);
      setChatMessages(prev => [...prev, { role: 'model', text: res.text, urls: res.urls }]);
    } catch (e) {
      console.error(e);
    } finally {
      setIsChatLoading(false);
    }
  };

  const filteredNotes = useMemo(() => {
    return notes.filter(n => n.content.toLowerCase().includes(searchQuery.toLowerCase()));
  }, [notes, searchQuery]);

  return (
    <div className="fixed bottom-8 right-8 bg-stone-900/95 border border-stone-800 shadow-2xl panel-radius overflow-hidden flex flex-col z-[100] backdrop-blur-xl transition-all" style={{ width: panelSize.width, height: panelSize.height }}>
      
      {/* Header / Minimize Toggle */}
      <div className="flex items-center justify-between p-3 bg-stone-800/40 border-b border-stone-700/30">
        <div className="flex items-center gap-2">
          <ICONS.Shield className="text-stone-400" size={14} />
          <span className="text-[10px] uppercase font-black tracking-widest text-stone-200">ProSe Legal Terminal</span>
        </div>
        <button onClick={() => setIsMinimized(!isMinimized)} className="text-stone-500 hover:text-stone-200 p-1">
          {isMinimized ? <ICONS.Power size={14} /> : <ICONS.Minimize size={14} />}
        </button>
      </div>

      {!isMinimized && (
        <>
          {/* Docket / Nav Tabs */}
          <div className="bg-stone-800/20 border-b border-stone-700/30 flex p-3 gap-1 overflow-x-auto no-scrollbar">
            {Object.values(PanelTab).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)} className={`px-3 py-1.5 text-[8px] uppercase font-black tracking-widest rounded-full transition-all ${activeTab === tab ? 'bg-stone-100 text-stone-900 shadow-xl' : 'text-stone-500 hover:text-stone-300'}`}>{tab}</button>
            ))}
          </div>

          <div className="flex-1 overflow-hidden flex flex-col p-4 relative">
            {activeTab === PanelTab.NOTEPAD && (
              <div className="flex-1 flex flex-col gap-4">
                <div className="flex justify-between items-center bg-stone-950/40 p-3 rounded-2xl border border-stone-800">
                   <div className="flex items-center gap-3">
                      <ICONS.Folder className="text-stone-600" size={16} />
                      <span className="text-[9px] uppercase font-bold text-stone-400">Drive Sync: ProSe_Intake</span>
                   </div>
                   <button onClick={() => setShowRejected(!showRejected)} className="text-[8px] uppercase font-black text-stone-600 hover:text-stone-400">Rejected ({rejectedItems.length})</button>
                </div>

                {showRejected && (
                  <div className="bg-red-950/20 border border-red-900/30 p-4 rounded-2xl space-y-2 max-h-32 overflow-y-auto">
                     <h4 className="text-[8px] uppercase font-black text-red-500 mb-1">Rejection Log</h4>
                     {rejectedItems.map((r, i) => (
                       <div key={i} className="flex justify-between text-[9px]">
                          <span className="text-stone-300 truncate max-w-[120px]">{r.name}</span>
                          <span className="text-red-700 font-bold">{r.reason}</span>
                       </div>
                     ))}
                  </div>
                )}

                <input type="text" placeholder="Search records..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} className="bg-stone-950/40 border border-stone-800 rounded-2xl p-3 text-[10px] outline-none" />

                <div className="flex-1 overflow-y-auto space-y-3">
                  {filteredNotes.map(note => (
                    <div key={note.id} className="bg-stone-800/30 border border-stone-800/50 p-4 rounded-3xl relative group">
                      <div className="flex justify-between mb-3">
                        <div className="flex items-center gap-2">
                           {integrityStatus[note.id] ? <ICONS.Check className="text-emerald-500" size={10} /> : <ICONS.Warning className="text-orange-500" size={10} />}
                           <span className="text-[7px] uppercase font-bold text-stone-600">Conf: {Math.round(note.confidence * 100)}%</span>
                        </div>
                        <span className="text-[7px] text-stone-700">{new Date(note.timestamp).toLocaleDateString()}</span>
                      </div>
                      <p className="text-xs text-stone-300">{note.content}</p>
                      <div className="mt-4 opacity-0 group-hover:opacity-100 transition-opacity">
                        <input type="range" min="0" max="1" step="0.05" value={note.confidence} onChange={e => updateConfidence(note.id, parseFloat(e.target.value))} className="w-full accent-stone-400 h-1 bg-stone-900 rounded-full cursor-pointer" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {activeTab === PanelTab.CHAT && (
              <div className="flex-1 flex flex-col gap-4">
                <div className="flex-1 overflow-y-auto space-y-4 pr-1">
                  {chatMessages.map((m, i) => (
                    <div key={i} className={`p-4 rounded-3xl text-xs max-w-[90%] ${m.role === 'user' ? 'bg-stone-800 self-end ml-auto' : 'bg-stone-950 border border-stone-800'}`}>
                       {m.text}
                       {m.urls && m.urls.length > 0 && (
                         <div className="mt-2 pt-2 border-t border-stone-800/50 flex flex-wrap gap-2">
                            {m.urls.map((u, ui) => <a key={ui} href={u.uri} target="_blank" className="text-[8px] bg-stone-800 p-1 px-2 rounded-full text-stone-500 hover:text-stone-300">Link</a>)}
                         </div>
                       )}
                    </div>
                  ))}
                  {isChatLoading && <div className="text-[8px] uppercase text-stone-700 animate-pulse">Gemini is searching...</div>}
                </div>
                <div className="flex gap-2">
                   <input type="text" value={chatInput} onChange={e => setChatInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleChat()} className="flex-1 bg-stone-950/40 border border-stone-800 rounded-2xl p-4 text-[11px] outline-none" placeholder="Ask Gemini (Pro)..." />
                   <button onClick={handleChat} className="bg-stone-100 text-stone-900 px-6 rounded-2xl font-black uppercase text-[10px]">Send</button>
                </div>
              </div>
            )}

            {activeTab === PanelTab.LIVE && (
              <div className="flex-1 flex flex-col items-center justify-center gap-8 text-center">
                 <div className={`w-32 h-32 rounded-full border-4 border-dashed transition-all duration-1000 flex items-center justify-center ${isLiveActive ? 'border-emerald-500 animate-spin-slow shadow-[0_0_50px_rgba(16,185,129,0.2)]' : 'border-stone-800'}`}>
                    <ICONS.Mic size={48} className={isLiveActive ? 'text-emerald-500' : 'text-stone-700'} />
                 </div>
                 <div className="space-y-4">
                    <h3 className="text-lg font-serif italic text-stone-100">{isLiveActive ? 'Voice Session Active' : 'Native Audio Interface'}</h3>
                    <p className="text-[10px] text-stone-500 uppercase tracking-widest max-w-[200px]">Real-time legal briefing with Gemini 2.5 Native Audio</p>
                    <button onClick={startLiveSession} className={`px-10 py-4 rounded-full font-black uppercase text-[12px] transition-all ${isLiveActive ? 'bg-red-500/20 text-red-500 border border-red-500/30' : 'bg-emerald-600 text-white shadow-xl shadow-emerald-900/20 hover:scale-105'}`}>
                       {isLiveActive ? 'End Briefing' : 'Start Live Audio'}
                    </button>
                 </div>
              </div>
            )}
          </div>
        </>
      )}

      <style>{`
        @keyframes spin-slow { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .animate-spin-slow { animation: spin-slow 10s linear infinite; }
        .no-scrollbar::-webkit-scrollbar { display: none; }
        .panel-radius { border-radius: 2rem; }
      `}</style>
    </div>
  );
};

export default App;
