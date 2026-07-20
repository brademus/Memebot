import { randomUUID } from 'node:crypto';
import { buildReport } from './report';
import { createSingleFileZip } from './single-file-zip';

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
  resultBytes: number;
  archive: Buffer | null;
  archiveBytes: number;
  downloadFilename: string | null;
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
  archiveBytes: number;
  downloadFilename: string | null;
  downloadPath: string | null;
  error: string | null;
  reused?: boolean;
}

export interface ReportJobArchive {
  filename: string;
  buffer: Buffer;
}

interface ReportJobManagerOptions {
  readyTtlMs?: number;
  runningTtlMs?: number;
  maxRetainedJobs?: number;
}

const DEFAULT_READY_TTL_MS = 30 * 60_000;
const DEFAULT_RUNNING_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_RETAINED_JOBS = 2;

export class ReportJobManager {
  private readonly jobs = new Map<string, InternalReportJob>();
  private activeJobId: string | null = null;
  private readonly readyTtlMs: number;
  private readonly runningTtlMs: number;
  private readonly maxRetainedJobs: number;

  constructor(
    private readonly builder: (days: number) => Promise<unknown> = buildReport,
    options: ReportJobManagerOptions = {},
  ) {
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
      resultBytes: 0,
      archive: null,
      archiveBytes: 0,
      downloadFilename: null,
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

  getArchive(id: string): ReportJobArchive | null {
    this.cleanup();
    const job = this.jobs.get(id);
    if (!job || job.status !== 'ready' || !job.archive || !job.downloadFilename) return null;
    return { filename: job.downloadFilename, buffer: job.archive };
  }

  private async generate(job: InternalReportJob): Promise<void> {
    job.status = 'building';
    job.message = 'Collecting database, model, execution, and trade evidence.';
    job.updatedAt = Date.now();
    try {
      const report = await this.builder(job.days);
      job.message = 'Serializing the complete review.';
      job.updatedAt = Date.now();
      const raw = Buffer.from(JSON.stringify(report, null, 2), 'utf8');
      job.resultBytes = raw.length;

      job.message = 'Compressing the review into a ZIP file.';
      job.updatedAt = Date.now();
      const finished = new Date();
      job.archive = createSingleFileZip('daily-master-review.json', raw, finished);
      job.archiveBytes = job.archive.length;
      job.downloadFilename = `memebot-daily-master-review-${finished.toISOString().slice(0, 10)}.zip`;
      job.status = 'ready';
      job.message = 'ZIP file ready to download and upload into ChatGPT.';
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
      archiveBytes: job.archiveBytes,
      downloadFilename: job.downloadFilename,
      downloadPath: job.status === 'ready' ? `/api/daily-review-jobs/${job.id}/download` : null,
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
