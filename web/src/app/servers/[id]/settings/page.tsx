"use client";

import { use, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";

// Fallback list — only shown if the per-slot maps API hasn't responded yet
// or the slot's game tree isn't populated. Once the real list loads we
// replace it.
const DEFAULT_MAPS = ["dl_streets", "dl_midtown", "dl_hideout"];

export default function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [form, setForm] = useState({
    name: "", port: 27015, map: "dl_streets", password: "",
    steam_login: "", steam_pass: "", steam_2fa: "", skip_update: 1,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [maps, setMaps] = useState<string[]>(DEFAULT_MAPS);

  // Upload state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStatus, setUploadStatus] = useState<{ kind: "idle" | "ok" | "error"; msg: string }>({ kind: "idle", msg: "" });
  const [dragActive, setDragActive] = useState(false);
  const [pendingFile, setPendingFile] = useState<{ name: string; size: number } | null>(null);

  async function refreshMaps() {
    const r = await fetch(`/api/servers/${id}/maps`);
    if (r.ok) {
      const data = await r.json();
      if (Array.isArray(data.maps) && data.maps.length > 0) setMaps(data.maps);
    }
  }

  function uploadFile(file: File, overwrite: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setUploadProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject({ status: xhr.status, body: xhr.responseText });
        }
      };
      xhr.onerror = () => reject({ status: 0, body: "network error" });
      const url = `/api/servers/${id}/maps/upload?name=${encodeURIComponent(file.name)}&overwrite=${overwrite}`;
      xhr.open("PUT", url);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.send(file);
    });
  }

  function formatBytes(b: number): string {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
    return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  async function handleUpload(file: File) {
    if (!/^[A-Za-z0-9_]+\.vpk$/.test(file.name)) {
      setUploadStatus({ kind: "error", msg: `Filename must match ^[A-Za-z0-9_]+\\.vpk$ — rename "${file.name}" first` });
      return;
    }
    setUploading(true);
    setUploadProgress(0);
    setPendingFile({ name: file.name, size: file.size });
    setUploadStatus({ kind: "idle", msg: "" });

    try {
      await uploadFile(file, false);
      setUploadStatus({ kind: "ok", msg: `Uploaded ${file.name}` });
      await refreshMaps();
    } catch (err: any) {
      if (err?.status === 409) {
        if (window.confirm(`${file.name} already exists. Replace it?`)) {
          try {
            await uploadFile(file, true);
            setUploadStatus({ kind: "ok", msg: `Replaced ${file.name}` });
            await refreshMaps();
          } catch (e: any) {
            setUploadStatus({ kind: "error", msg: parseError(e) });
          }
        } else {
          setUploadStatus({ kind: "idle", msg: "" });
        }
      } else {
        setUploadStatus({ kind: "error", msg: parseError(err) });
      }
    } finally {
      setUploading(false);
      setPendingFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function onDropFiles(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    if (uploading) return;
    const f = e.dataTransfer.files?.[0];
    if (f) handleUpload(f);
  }

  function parseError(err: any): string {
    try {
      const data = JSON.parse(err?.body ?? "{}");
      return data.error ?? `HTTP ${err?.status ?? "error"}`;
    } catch {
      return err?.body ?? `HTTP ${err?.status ?? "error"}`;
    }
  }

  useEffect(() => {
    fetch(`/api/servers/${id}`).then(async (r) => {
      if (r.status === 401) { router.push("/login"); return; }
      if (!r.ok) { router.push("/"); return; }
      const data = await r.json();
      setForm({
        name: data.name, port: data.port, map: data.map, password: data.password,
        steam_login: data.steam_login, steam_pass: "", steam_2fa: data.steam_2fa,
        skip_update: data.skip_update,
      });
    });
  }, [id]);

  useEffect(() => { refreshMaps(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  function update(field: string, value: string | number) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");

    const res = await fetch(`/api/servers/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update", ...form }),
    });

    if (res.ok) {
      router.push(`/servers/${id}`);
    } else {
      const data = await res.json();
      setError(data.error || "Failed to save");
      setSaving(false);
    }
  }

  async function handleDelete() {
    await fetch(`/api/servers/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", deleteFiles: true }),
    });
    router.push("/");
  }

  const inputClass = "w-full px-4 py-2 bg-neutral-800 border border-neutral-700 rounded text-neutral-100 placeholder-neutral-500 focus:outline-none focus:border-[#eb3449]";
  const labelClass = "block text-sm font-medium text-neutral-300 mb-1";

  return (
    <motion.div
      className="max-w-lg mx-auto"
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 28 }}
    >
      <h1 className="text-2xl font-bold mb-6">Server Settings</h1>

      <form onSubmit={handleSave} className="space-y-4">
        <div>
          <label className={labelClass}>Server Name</label>
          <input className={inputClass} value={form.name} onChange={(e) => update("name", e.target.value)} required />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Port</label>
            <input className={inputClass} type="number" value={form.port} onChange={(e) => update("port", parseInt(e.target.value))} required />
          </div>
          <div>
            <label className={labelClass}>Map</label>
            <select
              className={inputClass + " cursor-pointer"}
              value={form.map}
              onChange={(e) => update("map", e.target.value)}
              required
            >
              {/* Always include the currently-selected map as a fallback option
                  so the select isn't visually empty if the API list hasn't
                  arrived yet or the map was renamed/uninstalled. */}
              {!maps.includes(form.map) && form.map && (
                <option value={form.map}>{form.map} (not installed)</option>
              )}
              {maps.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-neutral-500">
              {maps.length} map{maps.length === 1 ? "" : "s"} installed
            </p>
          </div>
        </div>

        <div>
          <label className={labelClass}>Upload Map</label>
          <input
            ref={fileInputRef}
            type="file"
            accept=".vpk"
            disabled={uploading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleUpload(f);
            }}
            className="hidden"
          />
          <motion.div
            onClick={() => !uploading && fileInputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); if (!uploading) setDragActive(true); }}
            onDragEnter={(e) => { e.preventDefault(); if (!uploading) setDragActive(true); }}
            onDragLeave={(e) => { e.preventDefault(); setDragActive(false); }}
            onDrop={onDropFiles}
            whileHover={!uploading ? { scale: 1.005 } : {}}
            whileTap={!uploading ? { scale: 0.995 } : {}}
            role="button"
            tabIndex={uploading ? -1 : 0}
            aria-disabled={uploading}
            className={`relative overflow-hidden rounded-lg border border-dashed transition-colors
              ${uploading ? "cursor-default" : "cursor-pointer"}
              ${dragActive
                ? "border-[#eb3449] bg-[#eb3449]/5"
                : uploading
                  ? "border-neutral-700 bg-neutral-900/50"
                  : "border-neutral-700 hover:border-neutral-500 hover:bg-neutral-900/40"}
            `}
          >
            <div className="px-5 py-6 flex flex-col items-center text-center gap-2">
              <div className={`w-11 h-11 rounded-full flex items-center justify-center transition-colors ${dragActive ? "bg-[#eb3449]/20 text-[#f05c6a]" : uploading ? "bg-neutral-800 text-neutral-400" : "bg-neutral-800 text-neutral-300 group-hover:text-neutral-100"}`}>
                {uploading ? (
                  <svg className="w-5 h-5 animate-spin" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="14 28" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                )}
              </div>

              {uploading && pendingFile ? (
                <>
                  <p className="text-sm font-medium text-neutral-100 break-all">{pendingFile.name}</p>
                  <p className="text-xs text-neutral-500">
                    {formatBytes(Math.round((uploadProgress / 100) * pendingFile.size))} / {formatBytes(pendingFile.size)} — {uploadProgress}%
                  </p>
                </>
              ) : dragActive ? (
                <>
                  <p className="text-sm font-medium text-[#f05c6a]">Drop to upload</p>
                  <p className="text-xs text-neutral-500">Release the file here</p>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium text-neutral-100">
                    Drop a <code className="text-[#f05c6a] font-mono">.vpk</code> here, or <span className="underline underline-offset-2">click to browse</span>
                  </p>
                  <p className="text-xs text-neutral-500">
                    Streams directly to the slot. Filename must match <code className="text-neutral-400 font-mono">^[A-Za-z0-9_]+.vpk$</code>
                  </p>
                </>
              )}
            </div>

            {uploading && (
              <div className="absolute inset-x-0 bottom-0 h-1 bg-neutral-800">
                <motion.div
                  initial={false}
                  animate={{ width: `${uploadProgress}%` }}
                  transition={{ type: "spring", stiffness: 240, damping: 30 }}
                  className="h-full bg-gradient-to-r from-[#eb3449] to-[#c42a3b]"
                />
              </div>
            )}
          </motion.div>

          {!uploading && uploadStatus.msg && (
            <motion.p
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              className={`mt-2 text-xs flex items-center gap-1.5 ${
                uploadStatus.kind === "error"
                  ? "text-[#f05c6a]"
                  : uploadStatus.kind === "ok"
                    ? "text-emerald-400"
                    : "text-neutral-500"
              }`}
            >
              {uploadStatus.kind === "ok" && (
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
              {uploadStatus.kind === "error" && (
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              )}
              {uploadStatus.msg}
            </motion.p>
          )}
        </div>

        <div>
          <label className={labelClass}>Server Password</label>
          <input className={inputClass} value={form.password} onChange={(e) => update("password", e.target.value)} placeholder="Leave empty for no password" />
        </div>

        <div className="flex items-center gap-3">
          <input type="checkbox" id="skip" checked={form.skip_update === 1} onChange={(e) => update("skip_update", e.target.checked ? 1 : 0)} className="cursor-pointer rounded" />
          <label htmlFor="skip" className="cursor-pointer text-sm text-neutral-300">Skip SteamCMD update on restart</label>
        </div>

        <hr className="border-neutral-800" />

        <div>
          <label className={labelClass}>Steam Login</label>
          <input className={inputClass} value={form.steam_login} onChange={(e) => update("steam_login", e.target.value)} required />
        </div>
        <div>
          <label className={labelClass}>Steam Password</label>
          <input className={inputClass} type="password" value={form.steam_pass} onChange={(e) => update("steam_pass", e.target.value)} placeholder="Enter to change" />
        </div>
        <div>
          <label className={labelClass}>Steam 2FA Code</label>
          <input className={inputClass} value={form.steam_2fa} onChange={(e) => update("steam_2fa", e.target.value)} placeholder="From Steam Guard app" />
        </div>

        {error && <p className="text-[#f05c6a] text-sm">{error}</p>}

        <motion.button
          whileTap={{ scale: 0.97 }}
          type="submit"
          disabled={saving}
          className="cursor-pointer w-full py-2.5 bg-gradient-to-r from-[#eb3449] to-[#c42a3b] hover:from-[#f05c6a] hover:to-[#eb3449] disabled:bg-none disabled:bg-neutral-700 rounded font-medium transition-all"
        >
          {saving ? "Saving..." : "Save & Restart Server"}
        </motion.button>
      </form>

      <div className="mt-8 pt-6 border-t border-neutral-800">
        {!deleteConfirm ? (
          <motion.button
            whileTap={{ scale: 0.97 }}
            onClick={() => setDeleteConfirm(true)}
            className="cursor-pointer w-full py-2.5 bg-[#eb3449]/10 hover:bg-[#eb3449]/20 text-[#f05c6a] rounded font-medium transition-colors"
          >
            Delete Server
          </motion.button>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-[#f05c6a]">This will stop the container and delete all game files. Are you sure?</p>
            <div className="flex gap-2">
              <motion.button
                whileTap={{ scale: 0.97 }}
                onClick={handleDelete}
                className="cursor-pointer flex-1 py-2 bg-gradient-to-r from-[#eb3449] to-[#c42a3b] hover:from-[#f05c6a] hover:to-[#eb3449] rounded font-medium transition-all"
              >
                Yes, Delete
              </motion.button>
              <motion.button
                whileTap={{ scale: 0.97 }}
                onClick={() => setDeleteConfirm(false)}
                className="cursor-pointer flex-1 py-2 bg-neutral-800 hover:bg-neutral-700 rounded font-medium transition-colors"
              >
                Cancel
              </motion.button>
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}
