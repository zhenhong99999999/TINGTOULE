import React, { useState, useEffect, useRef } from "react";
import { 
  Search, 
  Play, 
  Clock, 
  FileText, 
  MessageSquare, 
  Download, 
  Loader2, 
  ChevronRight, 
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  Send,
  User,
  Bot,
  Share2,
  Twitter,
  Sparkles,
  Copy,
  Check,
  Plus,
  Settings
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { GoogleGenAI } from "@google/genai";
import ReactMarkdown from "react-markdown";
import { cn, formatDuration } from "./lib/utils";

// --- Types ---
interface PodcastMetadata {
  title: string;
  showName: string;
  description: string;
  coverUrl: string;
  audioUrl: string;
  duration: number;
  url: string;
}

interface TranscriptionSegment {
  startTime: string;
  text: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// --- App Component ---
export default function App() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [metadata, setMetadata] = useState<PodcastMetadata | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  const [step, setStep] = useState<"input" | "processing" | "result">("input");
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  
  const [transcription, setTranscription] = useState<TranscriptionSegment[]>([]);
  const [summary, setSummary] = useState<string>("");
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [userInput, setUserInput] = useState("");
  const [isGeneratingSummary, setIsGeneratingSummary] = useState(false);
  const [isChatting, setIsChatting] = useState(false);
  const [isGeneratingSocialPosts, setIsGeneratingSocialPosts] = useState(false);
  const [socialPosts, setSocialPosts] = useState<{ xhs: string; x: string } | null>(null);
  const [copiedType, setCopiedType] = useState<string | null>(null);
  const [suggestedQuestions, setSuggestedQuestions] = useState<string[]>([]);

  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory]);

  const extractAndParseJSON = (text: string) => {
    try {
      // Try parsing directly first
      return JSON.parse(text.trim());
    } catch (e) {
      console.error("JSON extraction failed. Response text:", text);
      // If direct parsing fails, try to extract the first valid JSON object
      const firstBrace = text.indexOf("{");
      if (firstBrace === -1) throw new Error("未能找到有效的数据内容。");
      
      // Try to find the matching closing brace
      let braceCount = 0;
      let lastBrace = -1;
      let inString = false;
      let escape = false;

      for (let i = firstBrace; i < text.length; i++) {
        const char = text[i];
        if (char === '"' && !escape) inString = !inString;
        if (char === '\\' && !escape) escape = true; else escape = false;

        if (!inString) {
          if (char === "{") braceCount++;
          if (char === "}") braceCount--;
          if (braceCount === 0) {
            lastBrace = i;
            break;
          }
        }
      }
      
      if (lastBrace === -1) {
        // Fallback to lastIndexOf if matching failed (e.g. malformed but maybe parseable)
        const fallbackLastBrace = text.lastIndexOf("}");
        if (fallbackLastBrace === -1) throw new Error("未能找到有效的数据内容。");
        const jsonStr = text.substring(firstBrace, fallbackLastBrace + 1);
        return JSON.parse(jsonStr);
      }
      
      const jsonStr = text.substring(firstBrace, lastBrace + 1);
      return JSON.parse(jsonStr);
    }
  };

  const handleParse = async () => {
    if (!url) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await response.json();
      if (data.error) throw new Error(data.error);
      setMetadata(data);
      setStep("input");
    } catch (err: any) {
      setError(err.message || "解析失败，请检查链接格式");
    } finally {
      setLoading(false);
    }
  };

  const startProcessing = async () => {
    if (!metadata) return;
    setStep("processing");
    setProgress(10);
    setStatus("正在通过代理获取音频流...");

    try {
      // 1. Fetch audio via proxy
      const audioProxyUrl = `/api/audio-proxy?url=${encodeURIComponent(metadata.audioUrl)}`;
      const audioResponse = await fetch(audioProxyUrl);
      if (!audioResponse.ok) throw new Error("无法获取音频文件");
      
      setProgress(30);
      setStatus("正在读取并压缩音频数据...");
      const audioBlob = await audioResponse.blob();
      console.log("Compressed audio size:", (audioBlob.size / 1024 / 1024).toFixed(2), "MB");
      
      // Increased limit to 30MB (enough for ~2 hours of compressed audio)
      if (audioBlob.size > 30 * 1024 * 1024) {
        throw new Error("音频文件过大（超过 2 小时）。请尝试处理较短的播客。");
      }
      
      // Convert blob to base64
      const reader = new FileReader();
      const base64Promise = new Promise<string>((resolve) => {
        reader.onloadend = () => {
          const base64String = (reader.result as string).split(",")[1];
          resolve(base64String);
        };
      });
      reader.readAsDataURL(audioBlob);
      const base64Audio = await base64Promise;

      setProgress(50);
      setStatus("正在上传至 Gemini 进行 AI 分析...");

      // 2. Call Gemini with Audio
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
      
      const result = await ai.models.generateContent({
        model: "gemini-flash-latest", // 使用官方推荐的稳定别名
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: audioBlob.type || "audio/mpeg",
                data: base64Audio,
              },
            },
            {
              text: `你是一个专业的播客分析专家。请听这段播客音频，并采用【金字塔原理】（结论先行、以上统下、归类分组、逻辑递进）生成一份深度结构化的笔记。

              任务要求：
              1. 生成一份详细的带时间戳的转录文本（每隔约1-2分钟标记一次）。
              2. 生成一份符合金字塔原理的结构化笔记（Markdown格式），包含：
                 - 【核心结论】：用1-2句话概括全篇最核心的价值或结论。
                 - 【结构化拆解】：采用三级结构（一级主题 -> 二级要点 -> 三级细节/原文引用）。确保逻辑严密，归类清晰。
                 - 【核心观点】：提取3-8个核心洞察，每个观点附带原文摘要和深度理解。
                 - 【行动建议/延展思考】：基于播客内容，为听众提供可落地的建议或值得深思的问题。
                 - 【延展阅读】：提供2-3个相关的知识点或背景资料链接。
              
              请以 JSON 格式返回结果，格式如下：
              {
                "transcription": [{"startTime": "00:00", "text": "..."}],
                "summary": "markdown content...",
                "suggestedQuestions": ["问题1", "问题2", "问题3"]
              }`,
            },
          ],
        },
        config: {
          responseMimeType: "application/json",
          maxOutputTokens: 4096,
        }
      });

      setProgress(90);
      setStatus("正在整理分析结果...");

      let responseText = result.text || "";
      
      const parsed = extractAndParseJSON(responseText);

      setTranscription(parsed.transcription || []);
      setSummary(parsed.summary || "生成总结失败");
      setSuggestedQuestions(parsed.suggestedQuestions || []);
      setStep("result");
    } catch (err: any) {
      console.error("Processing error:", err);
      setError(err.message || "处理失败，可能是音频过大或网络问题。");
      setStep("input");
    } finally {
      setLoading(false);
    }
  };

  const generateSummary = async (segments: TranscriptionSegment[]) => {
    setIsGeneratingSummary(true);
    const fullText = segments.map(s => `[${s.startTime}] ${s.text}`).join("\n");
    
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
      const response = await ai.models.generateContent({
        model: "gemini-flash-latest",
        contents: `你是一个专业的播客分析专家。请根据以下播客转录内容，采用【金字塔原理】（结论先行、以上统下、归类分组、逻辑递进）生成一份深度结构化的笔记。
        
        要求：
        1. 【核心结论】：用1-2句话概括全篇最核心的价值或结论。
        2. 【结构化拆解】：采用三级结构（一级主题 -> 二级要点 -> 三级细节/原文引用）。确保逻辑严密，归类清晰。
        3. 【核心观点】：提取3-8个核心洞察，每个观点附带原文摘要和深度理解。
        4. 【行动建议/延展思考】：基于播客内容，为听众提供可落地的建议或值得深思的问题。
        5. 【延展阅读】：提供2-3个相关的知识点或背景资料链接。
        
        请严格按照以下 JSON 格式返回：
        {
          "summary": "markdown content...",
          "suggestedQuestions": ["问题1", "问题2", "问题3"]
        }
        
        转录内容：
        ${fullText}`,
        config: {
          responseMimeType: "application/json",
          maxOutputTokens: 4096,
        }
      });
      
      let text = response.text || "";
      const parsed = extractAndParseJSON(text);
      setSummary(parsed.summary || "生成总结失败");
      setSuggestedQuestions(parsed.suggestedQuestions || []);
    } catch (err) {
      console.error("Summary generation error:", err);
      setSummary("AI 总结生成失败，请稍后重试。");
    } finally {
      setIsGeneratingSummary(false);
    }
  };

  const handleSendMessage = async (overrideMessage?: string) => {
    const messageToSend = overrideMessage || userInput;
    if (!messageToSend.trim() || isChatting) return;
    
    const newHistory: ChatMessage[] = [...chatHistory, { role: "user", content: messageToSend }];
    setChatHistory(newHistory);
    setUserInput("");
    setIsChatting(true);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
      const fullText = transcription.map(s => `[${s.startTime}] ${s.text}`).join("\n");
      
      const response = await ai.models.generateContent({
        model: "gemini-flash-latest",
        contents: [
          { text: `你是一个基于播客内容的【大师级内容架构师】。你的任务是根据播客的全文转录内容，以极高水准的逻辑、洞察力和表达力回答用户问题。

          请遵循以下【WriteLikeMaster-Skill】响应格式：

          1. **[Thought]** (思考过程)：
             - 简要分析用户问题的核心意图。
             - 检索播客内容中与之最相关的片段。
             - 构思回答的逻辑框架。

          2. **[Response]** (正式回答)：
             - 采用专业、深刻且富有启发性的语言。
             - 结论先行，逻辑严密，归类清晰。
             - 引用播客原文（带时间戳）来支持你的观点。
             - 如果播客中未提及，请明确告知，并基于你的专业知识进行适度的高质量延展。

          3. **[Next Steps]** (后续建议)：
             - 基于当前对话，为用户推荐1-2个值得进一步探讨的问题或行动建议。

          以下是播客的全文转录内容：\n\n${fullText}` },
          ...newHistory.map(msg => ({ text: `${msg.role === "user" ? "用户" : "助手"}: ${msg.content}` })),
          { text: "助手:" }
        ],
      });

      setChatHistory([...newHistory, { role: "assistant", content: response.text || "抱歉，我无法回答这个问题。" }]);
    } catch (err) {
      console.error("Chat error:", err);
      setChatHistory([...newHistory, { role: "assistant", content: "对话服务暂时不可用。" }]);
    } finally {
      setIsChatting(false);
    }
  };

  const generateSocialPosts = async () => {
    if (isGeneratingSocialPosts) return;
    setIsGeneratingSocialPosts(true);
    
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
      const fullText = transcription.map(s => `[${s.startTime}] ${s.text}`).join("\n");
      const chatContext = chatHistory.map(m => `${m.role}: ${m.content}`).join("\n");
      
      const response = await ai.models.generateContent({
        model: "gemini-flash-latest",
        contents: `你是一个顶级社交媒体爆款专家，擅长将长内容转化为极具传播力的短视频/图文文案。请根据以下播客内容和我们的对话记录，生成两份不同风格的社交媒体文案。
        
        播客内容：
        ${fullText.substring(0, 10000)}...
        
        对话背景：
        ${chatContext}
        
        请严格按照以下 JSON 格式返回：
        {
          "xhs": "【小红书爆款文案】\\n格式要求：\\n1. 爆款标题：使用吸睛、情绪化、引发好奇的标题（包含 Emoji）。\\n2. 结构化正文：使用 Emoji 作为列表符号，分点陈述核心干货/感悟。语气亲切、像在和朋友分享。\\n3. 长尾标签：在文案末尾添加 5-10 个精准的热门和长尾标签。\\n参考风格：'别让XX把你养成XX'、'整理了X个受用终身的认知'。",
          "x": "【X (Twitter) 风格文案 - 英文版】\\n请使用英文生成。简洁、有力、有观点。可以是单条推文或 3-5 条的 Thread 结构。包含核心金句，适合转发传播。"
        }
        
        注意：只需返回 JSON，不要有任何其他文字。`,
        config: {
          responseMimeType: "application/json",
          maxOutputTokens: 4096,
        }
      });

      let text = response.text || "";
      const parsed = extractAndParseJSON(text);
      setSocialPosts(parsed);
    } catch (err) {
      console.error("Social post generation error:", err);
    } finally {
      setIsGeneratingSocialPosts(false);
    }
  };

  const copyToClipboard = (text: string, type: string) => {
    navigator.clipboard.writeText(text);
    setCopiedType(type);
    setTimeout(() => setCopiedType(null), 2000);
  };

  const exportMarkdown = () => {
    if (!metadata) return;
    const date = new Date().toISOString().split('T')[0];
    const fileName = `${date}_${metadata.title}.md`;
    
    const content = `# ${metadata.title}
> 来源：[${metadata.url}](${metadata.url}) | 时长：${formatDuration(metadata.duration)} | 处理时间：${new Date().toLocaleString()}

## 📌 播客总结
${summary}

## 💬 对话记录
${chatHistory.map(m => `**${m.role === "user" ? "问" : "答"}**: ${m.content}`).join("\n\n")}

## 🏷️ 标签
#播客 #AI总结 #学习笔记
`;

    const blob = new Blob([content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-[#FBFBFD] text-[#1D1D1F] font-sans selection:bg-[#0071E3]/10">
      {/* Header */}
      <header className="bg-white/80 backdrop-blur-md border-b border-gray-100 sticky top-0 z-50">
        <div className="max-w-full mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 bg-black rounded-xl flex items-center justify-center text-white shadow-lg shadow-black/10">
              <Sparkles size={22} />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight">听透了</h1>
              <p className="text-[10px] text-gray-400 font-bold uppercase tracking-[0.2em]">Apple Style Edition</p>
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 rounded-full border border-gray-100">
              <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
              <span className="text-xs font-medium text-gray-500">AI Engine Ready</span>
            </div>
          </div>
        </div>
      </header>

      <main className={cn(
        "mx-auto px-4 py-4 transition-all duration-500 h-[calc(100vh-64px)]",
        step === "result" ? "max-w-full" : "max-w-4xl"
      )}>
        <AnimatePresence mode="wait">
          {step === "input" && (
            <motion.div 
              key="input"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 1.02 }}
              className="space-y-16 py-12"
            >
              <div className="text-center space-y-6">
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1 }}
                >
                  <h2 className="text-5xl font-extrabold tracking-tight sm:text-7xl bg-gradient-to-b from-black to-gray-500 bg-clip-text text-transparent">
                    把好播客变成好笔记
                  </h2>
                </motion.div>
                <motion.p 
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 }}
                  className="text-gray-400 text-xl max-w-2xl mx-auto font-medium"
                >
                  粘贴播客链接，AI 自动为您转录、总结并开启深度对话。
                </motion.p>
              </div>

              <div className="max-w-3xl mx-auto">
                <div className="backdrop-blur-2xl bg-white/70 border border-gray-100 p-2 rounded-[32px] shadow-2xl shadow-black/5">
                  <div className="relative flex items-center">
                    <div className="absolute left-6 text-gray-400">
                      <Search size={22} />
                    </div>
                    <input 
                      type="text" 
                      placeholder="粘贴播客链接..."
                      className="w-full pl-16 pr-40 py-6 bg-transparent rounded-[24px] text-xl font-medium focus:ring-0 outline-none placeholder:text-gray-300"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleParse()}
                    />
                    <button 
                      onClick={handleParse}
                      disabled={loading || !url}
                      className="absolute right-2 px-8 py-4 apple-button apple-button-primary flex items-center gap-2"
                    >
                      {loading ? <Loader2 className="animate-spin" size={20} /> : "获取内容"}
                    </button>
                  </div>
                </div>
                {error && (
                  <motion.p 
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mt-6 text-red-500 text-sm font-medium flex items-center justify-center gap-2 bg-red-50 py-3 rounded-2xl border border-red-100"
                  >
                    <AlertCircle size={16} /> {error}
                  </motion.p>
                )}
              </div>

              {metadata && (
                <motion.div 
                  initial={{ opacity: 0, y: 40 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="max-w-2xl mx-auto backdrop-blur-2xl bg-white/70 border border-gray-100 p-8 rounded-[40px] flex gap-8 items-center"
                >
                  <img 
                    src={metadata.coverUrl} 
                    alt={metadata.title} 
                    className="w-40 h-40 rounded-[32px] object-cover shadow-2xl shadow-black/10"
                    referrerPolicy="no-referrer"
                  />
                  <div className="flex-1 space-y-5">
                    <div className="space-y-2">
                      <p className="text-[#0071E3] text-xs font-bold uppercase tracking-[0.2em]">{metadata.showName}</p>
                      <h3 className="text-2xl font-bold leading-tight tracking-tight">{metadata.title}</h3>
                    </div>
                    <div className="flex items-center gap-6 text-gray-400 text-sm font-medium">
                      <span className="flex items-center gap-2 bg-gray-100 px-3 py-1 rounded-full"><Clock size={14} /> {formatDuration(metadata.duration)}</span>
                      <a href={metadata.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 hover:text-[#0071E3] transition-colors">
                        <ExternalLink size={14} /> 原始链接
                      </a>
                    </div>
                    <button 
                      onClick={startProcessing}
                      className="w-full py-5 apple-button apple-button-primary flex items-center justify-center gap-3 text-lg"
                    >
                      <Play size={20} fill="currentColor" /> 开始 AI 深度分析
                    </button>
                  </div>
                </motion.div>
              )}
            </motion.div>
          )}

          {step === "processing" && (
            <motion.div 
              key="processing"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="h-full flex flex-col items-center justify-center space-y-12"
            >
              <div className="relative">
                <div className="w-32 h-32 rounded-[40px] bg-white shadow-2xl flex items-center justify-center">
                  <Loader2 className="animate-spin text-[#0071E3]" size={48} />
                </div>
                <motion.div 
                  animate={{ scale: [1, 1.2, 1], opacity: [0.5, 1, 0.5] }}
                  transition={{ duration: 2, repeat: Infinity }}
                  className="absolute -inset-4 bg-[#0071E3]/5 rounded-[60px] -z-10"
                />
              </div>
              <div className="text-center space-y-4 max-w-md">
                <h3 className="text-2xl font-bold tracking-tight">{status}</h3>
                <div className="w-64 h-1.5 bg-gray-100 rounded-full mx-auto overflow-hidden">
                  <motion.div 
                    initial={{ width: 0 }}
                    animate={{ width: `${progress}%` }}
                    className="h-full bg-[#0071E3]"
                  />
                </div>
                <p className="text-gray-400 text-sm font-medium">这可能需要几分钟时间，请稍候...</p>
              </div>
            </motion.div>
          )}

          {step === "result" && (
            <motion.div 
              key="result"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="grid grid-cols-1 lg:grid-cols-12 gap-6 h-full"
            >
              {/* Left Column: Analysis (3/12) */}
              <div className="lg:col-span-3 flex flex-col gap-4 overflow-hidden">
                <section className="bg-white/80 backdrop-blur-xl rounded-[32px] flex flex-col flex-1 overflow-hidden border border-gray-100 shadow-sm">
                  <div className="p-6 border-b border-gray-50 flex items-center justify-between">
                    <h3 className="text-sm font-bold text-gray-400 uppercase tracking-widest">内容解析</h3>
                    <button onClick={exportMarkdown} className="p-2 hover:bg-gray-50 rounded-xl text-gray-400 hover:text-[#0071E3] transition-colors">
                      <Download size={18} />
                    </button>
                  </div>
                  
                  <div className="flex-1 overflow-y-auto p-6 space-y-8 custom-scrollbar">
                    {isGeneratingSummary ? (
                      <div className="space-y-4 animate-pulse">
                        <div className="h-4 bg-gray-100 rounded-full w-3/4"></div>
                        <div className="h-4 bg-gray-100 rounded-full w-full"></div>
                        <div className="h-4 bg-gray-100 rounded-full w-5/6"></div>
                      </div>
                    ) : (
                      <>
                        <div className="space-y-4">
                          <h4 className="text-xs font-bold text-[#0071E3] flex items-center gap-2">
                            <FileText size={14} /> 结构化笔记
                          </h4>
                          <div className="prose prose-sm prose-apple text-gray-600 leading-relaxed">
                            <ReactMarkdown>{summary}</ReactMarkdown>
                          </div>
                        </div>

                        <div className="space-y-4">
                          <h4 className="text-xs font-bold text-gray-400 uppercase tracking-wider">转录要点</h4>
                          <div className="space-y-3">
                            {transcription.map((seg, i) => (
                              <div key={i} className="p-4 bg-gray-50/50 rounded-2xl border border-transparent hover:border-gray-100 hover:bg-white transition-all cursor-pointer group">
                                <div className="flex items-center justify-between mb-2">
                                  <span className="text-[10px] font-mono font-bold text-[#0071E3] bg-blue-50 px-2 py-0.5 rounded-md">{seg.startTime}</span>
                                  <Play size={12} className="text-gray-300 group-hover:text-[#0071E3] transition-colors" />
                                </div>
                                <p className="text-xs text-gray-600 leading-relaxed">{seg.text}</p>
                              </div>
                            ))}
                          </div>
                        </div>
                      </>
                    )}
                  </div>

                  <div className="p-6 border-t border-gray-50 bg-gray-50/30">
                    <div className="flex gap-4 items-center">
                      <img 
                        src={metadata?.coverUrl} 
                        alt={metadata?.title} 
                        className="w-12 h-12 rounded-xl object-cover shadow-md"
                        referrerPolicy="no-referrer"
                      />
                      <div className="flex-1 min-w-0">
                        <h4 className="font-bold text-xs truncate">{metadata?.title}</h4>
                        <p className="text-[10px] text-gray-400 truncate">{metadata?.showName}</p>
                      </div>
                    </div>
                  </div>
                </section>
              </div>

              {/* Center Column: Chat (6/12) */}
              <div className="lg:col-span-6 flex flex-col overflow-hidden">
                <section className="bg-white/80 backdrop-blur-xl rounded-[32px] flex flex-col flex-1 overflow-hidden relative border border-gray-100 shadow-sm">
                  <div className="p-6 border-b border-gray-50 flex items-center justify-between">
                    <h3 className="text-sm font-bold text-gray-400 uppercase tracking-widest">对话播客</h3>
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 bg-green-500 rounded-full" />
                      <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Live Analysis</span>
                    </div>
                  </div>
                  
                  <div className="flex-1 overflow-y-auto p-8 space-y-8 custom-scrollbar">
                    {chatHistory.length === 0 && (
                      <div className="h-full flex flex-col items-center justify-center text-center space-y-8">
                        <div className="w-24 h-24 bg-gray-50 rounded-[40px] flex items-center justify-center text-gray-200">
                          <MessageSquare size={48} />
                        </div>
                        <div className="space-y-3">
                          <h2 className="text-3xl font-bold tracking-tight">开启深度对话</h2>
                          <p className="text-gray-400 max-w-sm mx-auto font-medium">您可以针对播客内容进行提问，AI 将基于转录内容为您解答。</p>
                        </div>
                        
                        {suggestedQuestions.length > 0 && (
                          <div className="space-y-4 max-w-md w-full">
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">您可以试着问：</p>
                            <div className="flex flex-col gap-2">
                              {suggestedQuestions.map((q, i) => (
                                <button 
                                  key={i}
                                  onClick={() => handleSendMessage(q)}
                                  className="text-xs bg-gray-50/50 border border-gray-100 hover:border-[#0071E3] hover:bg-white px-6 py-4 rounded-2xl transition-all text-gray-600 text-left shadow-sm font-medium group"
                                >
                                  <span className="group-hover:text-[#0071E3] transition-colors">{q}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                    {chatHistory.map((msg, i) => (
                      <motion.div 
                        key={i} 
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className={cn("flex gap-4", msg.role === "user" ? "flex-row-reverse" : "")}
                      >
                        <div className={cn(
                          "w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0",
                          msg.role === "user" ? "bg-black text-white" : "bg-blue-50 text-blue-600"
                        )}>
                          {msg.role === "user" ? <User size={16} /> : <Bot size={16} />}
                        </div>
                        <div className={cn(
                          "px-5 py-3 rounded-2xl text-sm max-w-[85%] leading-relaxed",
                          msg.role === "user" ? "bg-gray-100 text-gray-800" : "bg-white border border-gray-100 text-gray-700 shadow-sm"
                        )}>
                          <div className={cn("prose prose-sm max-w-none", msg.role === "user" ? "" : "prose-apple")}>
                            <ReactMarkdown>{msg.content}</ReactMarkdown>
                          </div>
                        </div>
                      </motion.div>
                    ))}
                    <div ref={chatEndRef} />
                  </div>

                  <div className="p-6 bg-white/50 backdrop-blur-md border-t border-gray-50">
                    <div className="relative flex items-center">
                      <input 
                        type="text" 
                        placeholder="向播客提问..."
                        className="w-full pl-6 pr-16 py-4 bg-gray-50 rounded-2xl text-sm font-medium focus:ring-4 focus:ring-[#0071E3]/5 outline-none border border-gray-100 transition-all"
                        value={userInput}
                        onChange={(e) => setUserInput(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleSendMessage()}
                      />
                      <button 
                        onClick={() => handleSendMessage()}
                        disabled={isChatting || !userInput.trim()}
                        className="absolute right-2 p-3 bg-black text-white rounded-xl disabled:opacity-30 transition-all hover:scale-105 active:scale-95"
                      >
                        {isChatting ? <Loader2 className="animate-spin" size={18} /> : <Send size={18} />}
                      </button>
                    </div>
                  </div>
                </section>
              </div>

              {/* Right Column: Creative (3/12) */}
              <div className="lg:col-span-3 flex flex-col gap-4 overflow-hidden">
                <section className="bg-white/80 backdrop-blur-xl rounded-[32px] flex flex-col flex-1 overflow-hidden border border-gray-100 shadow-sm">
                  <div className="p-6 border-b border-gray-50 flex items-center justify-between">
                    <h3 className="text-sm font-bold text-gray-400 uppercase tracking-widest">创作中心</h3>
                    <button 
                      onClick={generateSocialPosts}
                      disabled={isGeneratingSocialPosts}
                      className="p-2 hover:bg-gray-50 rounded-xl text-[#0071E3] transition-colors disabled:opacity-30"
                    >
                      {isGeneratingSocialPosts ? <Loader2 className="animate-spin" size={18} /> : <Sparkles size={18} />}
                    </button>
                  </div>

                  <div className="flex-1 overflow-y-auto p-6 space-y-8 custom-scrollbar">
                    {!socialPosts ? (
                      <div className="h-full flex flex-col items-center justify-center text-center space-y-6 opacity-40 py-12">
                        <div className="w-16 h-16 bg-gray-50 rounded-[24px] flex items-center justify-center text-gray-300">
                          <Share2 size={32} />
                        </div>
                        <div className="space-y-2">
                          <p className="text-xs font-bold text-gray-800">Studio 输出将保存在此处</p>
                          <p className="text-[10px] text-gray-400 leading-relaxed px-4">
                            点击上方闪烁图标，AI 将自动为您生成多平台社交媒体文案。
                          </p>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-6">
                        <div className="space-y-4">
                          <div className="flex items-center justify-between">
                            <h4 className="text-[10px] font-bold text-red-500 uppercase tracking-widest flex items-center gap-2">
                              <Plus size={12} /> 小红书文案
                            </h4>
                            <button onClick={() => copyToClipboard(socialPosts.xhs, 'xhs')} className="p-2 hover:bg-red-50 rounded-xl text-red-500 transition-colors">
                              {copiedType === 'xhs' ? <Check size={14} /> : <Copy size={14} />}
                            </button>
                          </div>
                          <div className="p-5 bg-red-50/30 rounded-[24px] border border-red-100/50 text-xs text-gray-700 leading-relaxed whitespace-pre-wrap">
                            {socialPosts.xhs}
                          </div>
                        </div>

                        <div className="space-y-4">
                          <div className="flex items-center justify-between">
                            <h4 className="text-[10px] font-bold text-blue-500 uppercase tracking-widest flex items-center gap-2">
                              <Twitter size={12} /> X (Twitter)
                            </h4>
                            <button onClick={() => copyToClipboard(socialPosts.x, 'x')} className="p-2 hover:bg-blue-50 rounded-xl text-blue-500 transition-colors">
                              {copiedType === 'x' ? <Check size={14} /> : <Copy size={14} />}
                            </button>
                          </div>
                          <div className="p-5 bg-blue-50/30 rounded-[24px] border border-blue-100/50 text-xs text-gray-700 leading-relaxed whitespace-pre-wrap">
                            {socialPosts.x}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="p-6 border-t border-gray-50 bg-gray-50/30">
                    <button className="w-full py-3 bg-black text-white rounded-2xl text-xs font-bold flex items-center justify-center gap-2 shadow-lg shadow-black/5 hover:scale-[1.02] active:scale-[0.98] transition-all">
                      <Settings size={14} /> 更多创作工具
                    </button>
                  </div>
                </section>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
