import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Type, FunctionDeclaration } from '@google/genai';
import { Mic, MicOff, Send, Terminal, Activity, Globe, Clock, Calendar } from 'lucide-react';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// --- Audio Streamer Utility ---
class AudioStreamer {
  audioContext: AudioContext | null = null;
  processor: ScriptProcessorNode | null = null;
  source: MediaStreamAudioSourceNode | null = null;
  stream: MediaStream | null = null;
  nextPlayTime = 0;
  activeSources: AudioBufferSourceNode[] = [];

  async startRecording(onAudioData: (base64Data: string) => void) {
    try {
      this.audioContext = new AudioContext({ sampleRate: 16000 });
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err: any) {
      throw new Error(`Microphone access denied. Please ensure your browser allows microphone access. If you are in a preview iframe, try opening the app in a new tab using the button in the top right.`);
    }
    this.source = this.audioContext.createMediaStreamSource(this.stream);
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);

    this.processor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);
      const pcm16 = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        pcm16[i] = Math.max(-32768, Math.min(32767, inputData[i] * 32768));
      }
      const buffer = new Uint8Array(pcm16.buffer);
      let binary = '';
      for (let i = 0; i < buffer.byteLength; i++) {
        binary += String.fromCharCode(buffer[i]);
      }
      onAudioData(btoa(binary));
    };

    this.source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
  }

  stopRecording() {
    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
  }

  playAudio(base64Audio: string) {
    if (!this.audioContext) return;
    
    const binary = atob(base64Audio);
    const pcm16 = new Int16Array(binary.length / 2);
    for (let i = 0; i < pcm16.length; i++) {
      const lsb = binary.charCodeAt(i * 2);
      const msb = binary.charCodeAt(i * 2 + 1);
      pcm16[i] = (msb << 8) | lsb;
    }
    
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / 32768;
    }
    
    const audioBuffer = this.audioContext.createBuffer(1, float32.length, 24000);
    audioBuffer.getChannelData(0).set(float32);
    
    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioContext.destination);
    
    const currentTime = this.audioContext.currentTime;
    if (this.nextPlayTime < currentTime) {
      this.nextPlayTime = currentTime;
    }
    
    source.start(this.nextPlayTime);
    this.nextPlayTime += audioBuffer.duration;
    
    this.activeSources.push(source);
    source.onended = () => {
      this.activeSources = this.activeSources.filter(s => s !== source);
    };
  }

  stopPlayback() {
    this.activeSources.forEach(source => {
      try { source.stop(); } catch (e) {}
    });
    this.activeSources = [];
    this.nextPlayTime = 0;
  }
}

// --- Tools Declarations ---
const openWebsiteDeclaration: FunctionDeclaration = {
  name: 'openWebsite',
  description: 'Open a website in a new tab. Use this when the user asks to open YouTube, Google, Facebook, Instagram, etc.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      url: {
        type: Type.STRING,
        description: 'The URL to open, e.g., https://youtube.com',
      },
    },
    required: ['url'],
  },
};

const getTimeDeclaration: FunctionDeclaration = {
  name: 'getTime',
  description: 'Get the current time.',
  parameters: {
    type: Type.OBJECT,
    properties: {},
  },
};

const getDateDeclaration: FunctionDeclaration = {
  name: 'getDate',
  description: 'Get the current date.',
  parameters: {
    type: Type.OBJECT,
    properties: {},
  },
};

const searchGoogleDeclaration: FunctionDeclaration = {
  name: 'searchGoogle',
  description: 'Perform a Google search for a specific query.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: { type: Type.STRING, description: 'The search query' },
    },
    required: ['query'],
  },
};

const playMusicDeclaration: FunctionDeclaration = {
  name: 'playMusic',
  description: 'Open a music streaming service to play music.',
  parameters: {
    type: Type.OBJECT,
    properties: {},
  },
};

const getWeatherDeclaration: FunctionDeclaration = {
  name: 'getWeather',
  description: 'Get the current weather for a specific location. If no location is specified, default to the user\'s likely location or ask them.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      location: { type: Type.STRING, description: 'The city name, e.g., London, New York' },
    },
    required: ['location'],
  },
};

// --- Main App Component ---
interface Message {
  id: string;
  role: 'user' | 'ai' | 'system';
  text: string;
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isListening, setIsListening] = useState(false);
  const [inputText, setInputText] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [currentTime, setCurrentTime] = useState(new Date().toLocaleTimeString());
  
  const sessionRef = useRef<any>(null);
  const audioStreamerRef = useRef<AudioStreamer | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date().toLocaleTimeString());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const addMessage = (role: 'user' | 'ai' | 'system', text: string) => {
    setMessages(prev => [...prev, { id: Date.now().toString() + Math.random(), role, text }]);
  };

  const toggleConnection = async () => {
    if (isListening || isConnecting) {
      // Disconnect
      if (sessionRef.current) {
        audioStreamerRef.current?.stopRecording();
        audioStreamerRef.current?.stopPlayback();
        setIsListening(false);
        addMessage('system', 'J.A.R.V.I.S. disconnected.');
        sessionRef.current = null;
      }
      return;
    }

    setIsConnecting(true);
    try {
      audioStreamerRef.current = new AudioStreamer();
      
      // Request microphone access first before connecting to the API
      await audioStreamerRef.current.startRecording((base64Data) => {
        if (sessionRef.current) {
          sessionRef.current.then((session: any) => {
            try {
              session.sendRealtimeInput({
                audio: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
              });
            } catch (e) {
              // Ignore errors if session is closed
            }
          });
        }
      });

      const sessionPromise = ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        callbacks: {
          onopen: () => {
            setIsListening(true);
            setIsConnecting(false);
            addMessage('system', 'J.A.R.V.I.S. online. Voice interface active.');
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle audio output
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio) {
              audioStreamerRef.current?.playAudio(base64Audio);
            }
            
            // Handle interruption
            if (message.serverContent?.interrupted) {
              audioStreamerRef.current?.stopPlayback();
            }
            
            // Handle text output (transcription or text response)
            const textPart = message.serverContent?.modelTurn?.parts.find(p => p.text);
            if (textPart && textPart.text) {
              setMessages(prev => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.role === 'ai') {
                  return [...prev.slice(0, -1), { ...lastMsg, text: lastMsg.text + textPart.text }];
                } else {
                  return [...prev, { id: Date.now().toString(), role: 'ai', text: textPart.text }];
                }
              });
            }

            // Handle Tool Calls
            if (message.toolCall) {
              const functionCalls = message.toolCall.functionCalls;
              if (functionCalls) {
                const responses = await Promise.all(functionCalls.map(async call => {
                  try {
                    if (call.name === 'openWebsite') {
                      const url = (call.args as any).url;
                      const win = window.open(url, '_blank');
                      if (!win) throw new Error('Popup blocked by browser');
                      addMessage('system', `Executing command: Opening ${url}`);
                      return { id: call.id, name: call.name, response: { result: 'Opened website successfully' } };
                    } else if (call.name === 'getTime') {
                      const time = new Date().toLocaleTimeString();
                      addMessage('system', `Executing command: Time is ${time}`);
                      return { id: call.id, name: call.name, response: { time } };
                    } else if (call.name === 'getDate') {
                      const date = new Date().toLocaleDateString();
                      addMessage('system', `Executing command: Date is ${date}`);
                      return { id: call.id, name: call.name, response: { date } };
                    } else if (call.name === 'searchGoogle') {
                      const query = (call.args as any).query;
                      const win = window.open(`https://www.google.com/search?q=${encodeURIComponent(query)}`, '_blank');
                      if (!win) throw new Error('Popup blocked by browser');
                      addMessage('system', `Executing command: Searching Google for "${query}"`);
                      return { id: call.id, name: call.name, response: { result: `Opened Google search for ${query}` } };
                    } else if (call.name === 'playMusic') {
                      const win = window.open('https://music.youtube.com', '_blank');
                      if (!win) throw new Error('Popup blocked by browser');
                      addMessage('system', `Executing command: Playing music`);
                      return { id: call.id, name: call.name, response: { result: 'Opened music streaming service' } };
                    } else if (call.name === 'getWeather') {
                      const location = (call.args as any).location || 'local';
                      addMessage('system', `Executing command: Fetching weather for ${location}`);
                      const res = await fetch(`https://wttr.in/${encodeURIComponent(location)}?format=j1`);
                      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
                      const data = await res.json();
                      const current = data.current_condition[0];
                      const weatherDesc = current.weatherDesc[0].value;
                      const tempC = current.temp_C;
                      const tempF = current.temp_F;
                      return { id: call.id, name: call.name, response: { weather: `${weatherDesc}, ${tempC}°C (${tempF}°F)` } };
                    }
                    return { id: call.id, name: call.name, response: { error: 'Unknown function' } };
                  } catch (e: any) {
                    addMessage('system', `Command Error (${call.name}): ${e.message}`);
                    return { id: call.id, name: call.name, response: { error: e.message } };
                  }
                }));
                
                sessionPromise.then(session => {
                  session.sendToolResponse({ functionResponses: responses });
                });
              }
            }
          },
          onclose: () => {
            setIsListening(false);
            setIsConnecting(false);
            addMessage('system', 'Connection closed.');
            audioStreamerRef.current?.stopRecording();
          },
          onerror: (error: any) => {
            console.error(error);
            addMessage('system', `Connection Error: ${error.message || 'Lost connection to J.A.R.V.I.S.'}`);
            setIsListening(false);
            setIsConnecting(false);
            audioStreamerRef.current?.stopRecording();
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
          },
          systemInstruction: "You are J.A.R.V.I.S., a highly advanced, intelligent, and efficient AI assistant. Keep your responses concise, professional, and helpful. You have access to tools to open websites, check the time, check the date, search Google, play music, and get the weather. Use them when requested.",
          tools: [{ functionDeclarations: [openWebsiteDeclaration, getTimeDeclaration, getDateDeclaration, searchGoogleDeclaration, playMusicDeclaration, getWeatherDeclaration] }],
          // @ts-ignore
          inputAudioTranscription: {},
          // @ts-ignore
          outputAudioTranscription: {},
        },
      });
      
      sessionRef.current = sessionPromise;
    } catch (error: any) {
      console.error(error);
      addMessage('system', `Initialization Error: ${error.message || 'Failed to initialize J.A.R.V.I.S.'}`);
      setIsConnecting(false);
      setIsListening(false);
    }
  };

  const sendTextMessage = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!inputText.trim() || !sessionRef.current) return;
    
    addMessage('user', inputText);
    const text = inputText;
    setInputText('');
    
    try {
      const session = await sessionRef.current;
      session.sendRealtimeInput({
        text: text
      });
    } catch (error: any) {
      console.error(error);
      addMessage('system', `Error sending message: ${error.message || 'Unknown error'}`);
    }
  };

  return (
    <>
      {/* Atmospheric Backgrounds */}
      <div className="atmosphere"></div>
      <div className="hex-grid"></div>
      <div className="scanline"></div>

      <div className="ui-grid">
        {/* Header */}
        <header className="jarvis-header">
          <div className="system-id">STARK-OS // J.A.R.V.I.S. // v4.0.2</div>
          <div className="clock">{currentTime}</div>
        </header>

        {/* Left Panel: Chat Area */}
        <aside className="chat-panel">
          {messages.length === 0 ? (
            <div className="chat-item">
              <div className="label-sm">System Notification</div>
              <div className="chat-bubble ai">Awaiting Initialization...</div>
            </div>
          ) : (
            messages.map((msg) => (
              <div key={msg.id} className="chat-item">
                <div className={`label-sm ${msg.role === 'user' ? 'user-label' : ''}`}>
                  {msg.role === 'user' ? 'User Input' : msg.role === 'system' ? 'System Notification' : 'J.A.R.V.I.S. Response'}
                </div>
                <div className={`chat-bubble ${msg.role === 'user' ? 'user' : 'ai'}`}>
                  {msg.text}
                </div>
              </div>
            ))
          )}
          <div ref={messagesEndRef} />
        </aside>

        {/* Center Panel: Visualizer & Mic */}
        <main className="center-panel">
          <div className={`arc-reactor ${isListening ? 'active' : ''}`}>
            <div className="arc-inner"></div>
            <button
              className={`mic-icon ${isListening ? 'active' : ''}`}
              onClick={toggleConnection}
              disabled={isConnecting}
            >
              {isListening ? (
                <Mic className="w-8 h-8" />
              ) : (
                <MicOff className="w-8 h-8" />
              )}
            </button>
          </div>
          <div className="status-text">
            {isConnecting ? 'Connecting...' : isListening ? 'Listening...' : 'Standby'}
          </div>
        </main>

        {/* Right Panel: System Diagnostics */}
        <aside className="diag-panel">
          <div className="diag-item">
            <div className="diag-meta">
              <span>CORE TEMPERATURE</span>
              <span>42&deg;C</span>
            </div>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: '42%' }}></div>
            </div>
          </div>
          <div className="diag-item">
            <div className="diag-meta">
              <span>SYNAPTIC UPLINK</span>
              <span>{isListening ? 'ACTIVE' : 'STABLE'}</span>
            </div>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: isListening ? '100%' : '88%' }}></div>
            </div>
          </div>
          <div className="diag-item">
            <div className="diag-meta">
              <span>MEMORY BUFFER</span>
              <span>12.4 TB/S</span>
            </div>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: '65%' }}></div>
            </div>
          </div>
          <div className="diag-item">
            <div className="diag-meta">
              <span>QUANTUM DECRYPT</span>
              <span>IDLE</span>
            </div>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: '12%' }}></div>
            </div>
          </div>
          <div style={{ marginTop: 'auto', fontFamily: 'var(--font-mono)', fontSize: '11px', opacity: 0.5 }}>
            ENC-KEY: 0x88f..a21<br />
            IP: 192.168.1.104<br />
            LATENCY: 4ms
          </div>
        </aside>

        {/* Footer: Input Bar */}
        <footer className="jarvis-footer">
          <form onSubmit={sendTextMessage} className="w-full flex items-center gap-[15px]">
            <div className="input-box">
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder="How can I help you today, Sir?"
                disabled={!isListening}
              />
              <span className="cursor"></span>
            </div>
            <button
              type="submit"
              disabled={!isListening || !inputText.trim()}
              className="btn-send"
            >
              Execute
            </button>
          </form>
        </footer>
      </div>
    </>
  );
}
