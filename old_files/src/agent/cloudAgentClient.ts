import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'node:crypto';

export interface CloudAgentConfig {
  cloudBaseUrl: string; // e.g. https://api.shopprint.cloud
  wsBaseUrl: string;    // e.g. wss://api.shopprint.cloud
  agentToken: string;   // Device secret only (no cloud DB secrets)
  pollIntervalMs?: number;
}

export class CloudAgentClient {
  private ws: WebSocket | null = null;
  private isConnected = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private processedOps = new Set<string>(); // In-memory opId dedup cache

  constructor(
    private config: CloudAgentConfig,
    private printExecutor: (job: any, filePath: string) => Promise<'SUCCESS' | 'UNCERTAIN' | 'DEFINITIVE_FAILURE'>
  ) {}

  public start(): void {
    this.connectWebSocket();
  }

  private connectWebSocket(): void {
    if (this.ws) {
      try { this.ws.terminate(); } catch (_) {}
    }

    const wsUrl = `${this.config.wsBaseUrl}/ws/agent?token=${encodeURIComponent(this.config.agentToken)}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', async () => {
      this.isConnected = true;
      // Reconnect recovery: On reconnect, query pending jobs because DB is authoritative
      await this.syncPendingJobs();
    });

    this.ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        // Handle compact hint format: { type: "job", id: "..." }
        if (msg.type === 'job' && msg.id) {
          await this.processJob(msg.id);
        }
      } catch (err) {
        // Discard invalid format
      }
    });

    this.ws.on('close', () => {
      this.isConnected = false;
      this.scheduleReconnect();
    });

    this.ws.on('error', () => {
      this.isConnected = false;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWebSocket();
    }, 5000);
  }

  // Reconnect recovery: Fetch authoritative pending jobs from server
  public async syncPendingJobs(): Promise<void> {
    try {
      const res = await fetch(`${this.config.cloudBaseUrl}/api/agent/jobs`, {
        headers: { 'Authorization': `Bearer ${this.config.agentToken}` }
      });
      if (!res.ok) return;

      const data: any = await res.json();
      if (Array.isArray(data.jobs)) {
        for (const job of data.jobs) {
          await this.processJob(job.jobId);
        }
      }
    } catch (_) {}
  }

  private async processJob(jobId: string): Promise<void> {
    const opId = `op_${jobId}_${crypto.randomBytes(4).toString('hex')}`;
    
    // Dedup guard: prevent duplicate concurrent runs
    if (this.processedOps.has(jobId)) {
      return;
    }
    this.processedOps.add(jobId);

    let tempFilePath: string | null = null;
    try {
      // 1. Fetch metadata and presigned download URL
      const metaRes = await fetch(`${this.config.cloudBaseUrl}/api/agent/jobs/${jobId}/download-url`, {
        headers: { 'Authorization': `Bearer ${this.config.agentToken}` }
      });

      if (!metaRes.ok) {
        this.processedOps.delete(jobId);
        return;
      }

      const jobData: any = await metaRes.json();
      if (!jobData.files || jobData.files.length === 0) {
        await this.reportStatus(jobId, 'DEFINITIVE_FAILURE', opId, 'No files associated with job');
        return;
      }

      const firstFile = jobData.files[0];
      const downloadUrl = firstFile.downloadUrl;

      // 2. Download file directly from R2
      const downloadRes = await fetch(downloadUrl);
      if (!downloadRes.ok) {
        await this.reportStatus(jobId, 'UNCERTAIN', opId, 'Failed to download file from storage');
        return;
      }

      const buffer = Buffer.from(await downloadRes.arrayBuffer());
      tempFilePath = path.join(os.tmpdir(), `print_${jobId}_${Date.now()}.pdf`);
      await fs.promises.writeFile(tempFilePath, buffer);

      // 3. Execute print using local print driver / SumatraPDF
      const outcome = await this.printExecutor(jobData, tempFilePath);

      // 4. Report outcome (Uncertain print outcome -> MANUAL_REVIEW, never auto-resubmit)
      await this.reportStatus(jobId, outcome, opId);
    } catch (err: any) {
      await this.reportStatus(jobId, 'UNCERTAIN', opId, err.message || 'Unexpected agent error');
    } finally {
      if (tempFilePath) {
        try { await fs.promises.unlink(tempFilePath); } catch (_) {}
      }
    }
  }

  private async reportStatus(
    jobId: string,
    outcome: 'SUCCESS' | 'UNCERTAIN' | 'DEFINITIVE_FAILURE',
    opId: string,
    reason?: string
  ): Promise<void> {
    try {
      await fetch(`${this.config.cloudBaseUrl}/api/agent/jobs/${jobId}/status`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.agentToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ outcome, opId, reason })
      });
    } catch (_) {}
  }

  public stop(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
    }
  }
}
