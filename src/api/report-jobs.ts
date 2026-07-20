import { randomUUID } from 'node:crypto';
import { buildReport } from './report';

export type ReportJobStatus = 'queued' | 'building' | 'ready' | 'error';

interface InternalReportJob {
  id: string;
  days: number;
  status: ReportJobStatus;
  message: string;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  expiresAt: number;
  resultText: string | null;
  resultBytes: number;
  totalChunks: number;
  error: string | null;
}

export interface ReportJobSummary {
  id: string;
  days: number;
  status: ReportJobStatus;
  message: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  expiresAt: string;
  elapsedSeconds: number;
  resultBytes: number;
  totalChunks: number;
  error: string | null;
  reused?: boolean;
}

export interface ReportJobChunk {
  id: string;
  index: number;
  totalChunks: number;
  chunk: string;
}

interface ReportJobManagerOptions {
  chunkCharacters?: number;
  readyTtlMs?: number;
  runningTtlMs?: number;
  maxRetainedJobs?: number;
}

const DEFAULT_CHUNK_CHARACTERS = 180_000;
const DEFAULT_READY_TTL_MS = 30 * 60_000;
const DEFAULT_RUNNING_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_RETAINED_JOBS = 4;

export class ReportJobManager {
  private readonly jobs = new Map<string, InternalReportJob>();
  private activeJobId: string | null = null;
  private readonly chunkCharacters: number;
  private readonly readyTtlMs: number;
  private readonly runningTtlMs: number;
  private readonly maxRetainedJobs: number;

  constructor(
    private readonly builder: (days: number) => Promise<unknown> = buildReport,
    options: ReportJobManagerOptions = {},
  ) {
    this.chunkCharacters = Math.max(10_000, options.chunkCharacters || DEFAULT_CHUNK_CHARACTERS);
    this.readyTtlMs = Math.max(60_000, options.readyTtlMs || DEFAULT_READY_TTL_MS);
    this.runningTtlMs = Math.max(60_000, options.runningTtlMs || DEFAULT_RUNNING_TTL_MS);
    this.maxRetainedJobs = Math.max(1, options.maxRetainedJobs || DEFAULT_MAX_RETAINED_JOBS);
  }

  start(days = 1): ReportJobSummary {
    this.cleanup();
    const boundedDays = Math.max(1, Math.min(7, Math.floor(days) || 1));
    const active = this.activeJobId ? this.jobs.get(this.activeJobId) : null;
    if (active && (active.status === 'queued' || active.status === 'building')) {
      return { ...this.summary(active), reused: true };
    }

    const now = Date.now();
    const job: InternalReportJob = {
      id: randomUUID(),
      days: boundedDays,
      status: 'queued',
      message: 'Queued on the report worker.',
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      expiresAt: now + this.runningTtlMs,
      resultText: null,
      resultBytes: 0,
      totalChunks: 0,
      error: null,
    };
    this.jobs.set(job.id, job);
    this.activeJobId = job.id;

    setImmediate(() => {
      void this.generate(job);
    });
    return this.summary(job);
  }

  get(id: string): ReportJobSummary | null {
    this.cleanup();
    const job = this.jobs.get(id);
    return job ? this.summary(job) : null;
  }

  getChunk(id: string, index: number): ReportJobChunk | null {
    this.cleanup();
    const job = this.jobs.get(id);
    if (!job || job.status !== 'ready' || job.resultText === null) return null;
    if (!Number.isInteger(index) || index < 0 || index >= job.totalChunks) return null;
    const start = index * this.chunkCharacters;
    const end = Math.min(job.resultText.length, start + this.chunkCharacters);
    return {
      id: job.id,
      index,
      totalChunks: job.totalChunks,
      chunk: job.resultText.slice(start, end),
    };
  }

  private async generate(job: InternalReportJob): Promise<void> {
    job.status = 'building';
    job.message = 'Collecting database, model, execution, and trade evidence.';
    job.updatedAt = Date.now();
    try {
      const report = await this.builder(job.days);
      job.message = 'Serializing the complete review for chunked delivery.';
      job.updatedAt = Date.now();
      const resultText = JSON.stringify(report, null, 2);
      job.resultText = resultText;
      job.resultBytes = Buffer.byteLength(resultText, 'utf8');
      job.totalChunks = Math.max(1, Math.ceil(resultText.length / this.chunkCharacters));
      job.status = 'ready';
      job.message = 'Review ready for download and copy.';
      job.finishedAt = Date.now();
      job.updatedAt = job.finishedAt;
      job.expiresAt = job.finishedAt + this.readyTtlMs;
    } catch (error) {
      job.status = 'error';
      job.error = (error as Error).message;
      job.message = 'Review generation failed.';
      job.finishedAt = Date.now();
      job.updatedAt = job.finishedAt;
      job.expiresAt = job.finishedAt + this.readyTtlMs;
    } finally {
      if (this.activeJobId === job.id) this.activeJobId = null;
      this.cleanup();
    }
  }

  private summary(job: InternalReportJob): ReportJobSummary {
    return {
      id: job.id,
      days: job.days,
      status: job.status,
      message: job.message,
      createdAt: new Date(job.createdAt).toISOString(),
      updatedAt: new Date(job.updatedAt).toISOString(),
      finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
      expiresAt: new Date(job.expiresAt).toISOString(),
      elapsedSeconds: Math.max(0, Math.round(((job.finishedAt || Date.now()) - job.createdAt) / 1000)),
      resultBytes: job.resultBytes,
      totalChunks: job.totalChunks,
      error: job.error,
    };
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (job.expiresAt <= now) {
        this.jobs.delete(id);
        if (this.activeJobId === id) this.activeJobId = null;
      }
    }
    if (this.jobs.size <= this.maxRetainedJobs) return;
    const oldest = [...this.jobs.values()]
      .filter(job => job.id !== this.activeJobId)
      .sort((left, right) => left.createdAt - right.createdAt);
    while (this.jobs.size > this.maxRetainedJobs && oldest.length) {
      this.jobs.delete(oldest.shift()!.id);
    }
  }
}

export const reportJobs = new ReportJobManager();
