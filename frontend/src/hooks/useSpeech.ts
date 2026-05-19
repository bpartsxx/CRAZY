/**
 * Wrappers around the browser Web Speech APIs (SpeechRecognition + SpeechSynthesis).
 * Works in Chrome, Edge, and Safari out of the box. Firefox has no SpeechRecognition.
 * No network calls — everything happens in the browser.
 */
import { useCallback, useEffect, useRef, useState } from "react";

// Minimal type shims since stock TS lib.dom doesn't include SpeechRecognition.
type SREvent = { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> };
type SR = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SREvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
};

declare global {
  interface Window {
    SpeechRecognition?: { new (): SR };
    webkitSpeechRecognition?: { new (): SR };
  }
}

export interface SpeechRecognitionState {
  supported: boolean;
  listening: boolean;
  /** Live transcript including interim (unconfirmed) words. */
  transcript: string;
  /** Last final transcript (only updates on stop / silence). */
  finalTranscript: string;
  error: string | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
  reset: () => void;
}

export function useSpeechRecognition(lang = "en-US"): SpeechRecognitionState {
  const [supported, setSupported] = useState(true);
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [finalTranscript, setFinalTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<SR | null>(null);

  useEffect(() => {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) { setSupported(false); return; }
    const rec = new Ctor();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = lang;
    rec.onresult = (e) => {
      let interim = "";
      let finalT = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0].transcript;
        if (r.isFinal) finalT += text;
        else interim += text;
      }
      setTranscript((finalT + interim).trim());
      if (finalT) setFinalTranscript((f) => (f + finalT).trim());
    };
    rec.onerror = (e) => {
      setError(e.error || "speech error");
      setListening(false);
    };
    rec.onend = () => setListening(false);
    rec.onstart = () => { setListening(true); setError(null); };
    recRef.current = rec;
    return () => {
      try { rec.abort(); } catch {}
      recRef.current = null;
    };
  }, [lang]);

  const start = useCallback(() => {
    setTranscript("");
    setFinalTranscript("");
    setError(null);
    try { recRef.current?.start(); } catch (e) { setError((e as Error).message); }
  }, []);
  const stop = useCallback(() => { try { recRef.current?.stop(); } catch {} }, []);
  const abort = useCallback(() => { try { recRef.current?.abort(); } catch {} }, []);
  const reset = useCallback(() => { setTranscript(""); setFinalTranscript(""); }, []);

  return { supported, listening, transcript, finalTranscript, error, start, stop, abort, reset };
}


export interface SpeechSynthesisState {
  supported: boolean;
  speaking: boolean;
  voices: SpeechSynthesisVoice[];
  voiceURI: string | null;
  setVoiceURI: (uri: string | null) => void;
  rate: number;
  setRate: (r: number) => void;
  /** Queue a sentence to be spoken. Returns true if queued. */
  speak: (text: string) => boolean;
  /** Cancel everything currently queued. */
  cancel: () => void;
}

const VOICE_KEY = "inbox:voice:uri";
const RATE_KEY = "inbox:voice:rate";

export function useSpeechSynthesis(): SpeechSynthesisState {
  const [supported] = useState(() => typeof window !== "undefined" && "speechSynthesis" in window);
  const [speaking, setSpeaking] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceURI, setVoiceURIState] = useState<string | null>(() => {
    try { return localStorage.getItem(VOICE_KEY); } catch { return null; }
  });
  const [rate, setRateState] = useState<number>(() => {
    try { return parseFloat(localStorage.getItem(RATE_KEY) || "1.05"); } catch { return 1.05; }
  });
  const pendingRef = useRef(0);

  useEffect(() => {
    if (!supported) return;
    const update = () => setVoices(window.speechSynthesis.getVoices());
    update();
    window.speechSynthesis.addEventListener("voiceschanged", update);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", update);
  }, [supported]);

  const setVoiceURI = useCallback((uri: string | null) => {
    setVoiceURIState(uri);
    try { uri ? localStorage.setItem(VOICE_KEY, uri) : localStorage.removeItem(VOICE_KEY); } catch {}
  }, []);
  const setRate = useCallback((r: number) => {
    setRateState(r);
    try { localStorage.setItem(RATE_KEY, String(r)); } catch {}
  }, []);

  const speak = useCallback((text: string) => {
    if (!supported) return false;
    const trimmed = text.trim();
    if (!trimmed) return false;
    const u = new SpeechSynthesisUtterance(trimmed);
    if (voiceURI) {
      const v = window.speechSynthesis.getVoices().find((v) => v.voiceURI === voiceURI);
      if (v) u.voice = v;
    }
    u.rate = rate;
    u.onstart = () => { pendingRef.current++; setSpeaking(true); };
    u.onend = () => { pendingRef.current = Math.max(0, pendingRef.current - 1); if (pendingRef.current === 0) setSpeaking(false); };
    u.onerror = () => { pendingRef.current = Math.max(0, pendingRef.current - 1); if (pendingRef.current === 0) setSpeaking(false); };
    window.speechSynthesis.speak(u);
    return true;
  }, [supported, voiceURI, rate]);

  const cancel = useCallback(() => {
    if (!supported) return;
    window.speechSynthesis.cancel();
    pendingRef.current = 0;
    setSpeaking(false);
  }, [supported]);

  return { supported, speaking, voices, voiceURI, setVoiceURI, rate, setRate, speak, cancel };
}
