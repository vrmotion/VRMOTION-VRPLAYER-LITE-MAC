import { createReadStream, existsSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

const types = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".svg", "image/svg+xml"],
  [".mp4", "video/mp4"],
  [".mov", "video/quicktime"],
  [".m4v", "video/x-m4v"],
  [".webm", "video/webm"],
  [".mkv", "video/x-matroska"],
  [".m3u8", "application/vnd.apple.mpegurl"],
  [".ts", "video/mp2t"],
  [".m4s", "video/iso.segment"]
]);

function sendFile(req, res, filePath) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const stat = statSync(filePath);
  const headers = {
    "Content-Type": types.get(ext) || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Access-Control-Allow-Origin": "*"
  };

  if (ext === ".m3u8") {
    headers["Cache-Control"] = "no-cache";
  } else if (ext === ".ts" || ext === ".m4s") {
    headers["Cache-Control"] = "public, max-age=31536000, immutable";
  } else {
    headers["Cache-Control"] = "public, max-age=3600";
  }

  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      res.end();
      return;
    }

    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : stat.size - 1;

    if (start >= stat.size || end >= stat.size || start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      res.end();
      return;
    }

    res.writeHead(206, {
      ...headers,
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${stat.size}`
    });
    createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    ...headers,
    "Content-Length": stat.size
  });
  createReadStream(filePath).pipe(res);
}

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const resolved = path.resolve(root, `.${decoded}`);
  return resolved.startsWith(path.resolve(root)) ? resolved : null;
}

function readBody(req, limit = 120 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Snapshot is too large"));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function formatSnapshotTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const restSeconds = total % 60;
  return `${minutes}${String(restSeconds).padStart(2, "0")}`;
}

function safeFileName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim() || "frame";
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(body));
}

export function startServer(options = {}) {
  const port = Number(options.port ?? process.env.PORT ?? 3000);
  const mediaDir = options.mediaDir || process.env.MEDIA_DIR || path.join(__dirname, "media");
  const externalMedia = options.externalMedia || new Map();

  const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Range"
    });
    res.end();
    return;
  }

  if (req.method === "POST" && pathname === "/snapshot") {
    try {
      const body = JSON.parse(await readBody(req));
      const sourceUrl = new URL(String(body.source || ""), `http://${req.headers.host || "localhost"}`);

      if (!sourceUrl.pathname.startsWith("/media/")) {
        throw new Error("Snapshot source must be a local media file");
      }

      const mediaPath = safeJoin(mediaDir, sourceUrl.pathname.replace(/^\/media/, ""));
      if (!mediaPath || !existsSync(mediaPath) || !statSync(mediaPath).isFile()) {
        throw new Error("Video file was not found");
      }

      const imageMatch = /^data:image\/jpe?g;base64,([\s\S]+)$/i.exec(String(body.image || ""));
      if (!imageMatch) {
        throw new Error("Snapshot image is not a JPG");
      }

      const baseName = safeFileName(path.basename(mediaPath, path.extname(mediaPath)));
      const timeStamp = formatSnapshotTime(body.time);
      const fileName = `${baseName}_${timeStamp}.jpg`;
      const outputPath = path.join(path.dirname(mediaPath), fileName);

      await writeFile(outputPath, Buffer.from(imageMatch[1], "base64"));
      sendJson(res, 200, { ok: true, fileName });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (pathname.startsWith("/media/")) {
    const filePath = safeJoin(mediaDir, pathname.replace(/^\/media/, ""));
    return filePath ? sendFile(req, res, filePath) : (res.writeHead(403), res.end("Forbidden"));
  }

  if (pathname.startsWith("/external-media/")) {
    const id = pathname.split("/")[2];
    const filePath = externalMedia.get(id);
    return filePath ? sendFile(req, res, filePath) : (res.writeHead(404), res.end("Not found"));
  }

  const filePath = safeJoin(publicDir, pathname);
  if (filePath && existsSync(filePath)) {
    return sendFile(req, res, filePath);
  }

  sendFile(req, res, path.join(publicDir, "index.html"));
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      console.log(`VRMOTION VRPLAYER is running on http://localhost:${actualPort}`);
      console.log(`Media directory: ${mediaDir}`);
      resolve({ server, port: actualPort, mediaDir, externalMedia });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer();
}
