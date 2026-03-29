import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";
import { exec } from "child_process";
import util from "util";
import FormData from "form-data";
import crypto from "crypto";

const execPromise = util.promisify(exec);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API: Parse Xiaoyuzhou Link
  app.post("/api/parse", async (req, res) => {
    const { url } = req.body;
    if (!url || !url.includes("xiaoyuzhoufm.com/episode/")) {
      return res.status(400).json({ error: "Invalid Xiaoyuzhou link" });
    }

    try {
      const { data } = await axios.get(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
        }
      });
      const $ = cheerio.load(data);

      // Extract metadata from JSON-LD or meta tags
      const title = $('meta[property="og:title"]').attr("content") || $("title").text();
      const showName = $('.podcast-title').text().trim() || $('meta[property="og:site_name"]').attr("content");
      const description = $('meta[name="description"]').attr("content") || "";
      const coverUrl = $('meta[property="og:image"]').attr("content");
      
      // Audio URL is usually in a script tag or hidden in the page
      // For Xiaoyuzhou, it's often in the window.__INITIAL_STATE__
      const scriptContent = $('script').filter((i, el) => $(el).html()?.includes('__INITIAL_STATE__')).html();
      let audioUrl = "";
      let duration = 0;

      if (scriptContent) {
        try {
          const stateStr = scriptContent.match(/window\.__INITIAL_STATE__\s*=\s*({.*?});/)?.[1];
          if (stateStr) {
            const state = JSON.parse(stateStr);
            const episode = state.episode?.data || state.episode;
            audioUrl = episode?.audioUrl || "";
            duration = episode?.duration || 0;
          }
        } catch (e) {
          console.error("Failed to parse initial state", e);
        }
      }

      if (!audioUrl) {
          // Fallback: try to find any mp3 link
          audioUrl = $('meta[property="og:audio"]').attr("content") || "";
      }

      res.json({
        title,
        showName,
        description,
        coverUrl,
        audioUrl,
        duration,
        url
      });
    } catch (error) {
      console.error("Parse error:", error);
      res.status(500).json({ error: "Failed to parse link" });
    }
  });

  // API: Audio Proxy with Real-time Compression
  app.get("/api/audio-proxy", async (req, res) => {
    const { url } = req.query;
    if (!url || typeof url !== "string") return res.status(400).send("URL required");

    try {
      const response = await axios({
        url,
        method: "GET",
        responseType: "stream",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          "Referer": "https://www.xiaoyuzhoufm.com/"
        }
      });

      res.setHeader("Content-Type", "audio/mpeg");
      
      // Use ffmpeg to compress: 
      // -ac 1 (mono), -ar 16000 (16kHz), -ab 24k (24kbps bitrate)
      // This makes a 60min podcast ~10MB
      const { spawn } = await import("child_process");
      const ffmpeg = spawn("ffmpeg", [
        "-i", "pipe:0",
        "-ac", "1",
        "-ar", "16000",
        "-ab", "24k",
        "-f", "mp3",
        "pipe:1"
      ]);

      response.data.pipe(ffmpeg.stdin);
      ffmpeg.stdout.pipe(res);

      ffmpeg.stderr.on("data", (data) => {
        // Optional: log ffmpeg progress
      });

      ffmpeg.on("error", (err) => {
        console.error("FFmpeg error:", err);
      });
    } catch (error) {
      console.error("Audio proxy error:", error);
      res.status(500).send("Failed to fetch and compress audio");
    }
  });

  // API: Transcription (Now using Gemini, so this becomes a helper or can be removed)
  app.post("/api/transcribe", async (req, res) => {
    // We'll handle this on the frontend using Gemini directly for simplicity and cost-efficiency
    res.json({ message: "Gemini will handle this directly" });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
