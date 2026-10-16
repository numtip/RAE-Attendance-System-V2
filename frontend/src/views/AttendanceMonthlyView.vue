<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ApiError, api } from '../api/client';
import type {
  AttendanceExportFile,
  AttendanceExportFormat,
  AttendanceMonthReport,
  ReportComputationStatus,
} from '../api/types';
import { getStoredEmployee } from '../auth/session';
import { isReviewFixtureMode } from '../config/reviewMode';
import AsyncState from '../components/AsyncState.vue';

/**
 * R-02: this view reads the report endpoint, NOT the legacy `/attendance/monthly` route, because only the
 * report carries `computationStatus` / `isFinal`. A month that the engine could not judge in full is shown
 * as provisional and its figures are de-emphasised — it is never presented as a final result.
 */
const STATUS_LABEL: Record<ReportComputationStatus, string> = {
  calculated: 'Calculated',
  no_data: 'No data',
  insufficient_data: 'Insufficient data',
  partial: 'Partial',
  pending_policy: 'Pending policy',
  failed: 'Failed',
  not_derived: 'Not derived',
};

const REASON_LABEL: Record<string, string> = {
  month_partial: 'Some days in this month could not be judged.',
  month_pending_policy: 'No approved attendance rule covers every day of this month.',
  month_no_daily_rows: 'No attendance was derived for this month.',
  month_never_derived: 'This month has never been derived.',
  month_failed: 'Deriving this month failed.',
};

function describeReason(reason: string): string {
  const [code, value] = reason.split(':');
  if (code === 'unjudged_days') return `${value} day(s) could not be judged.`;
  return REASON_LABEL[code] ?? reason;
}

const now = new Date();
const employeeUid = computed(() => getStoredEmployee()?.employeeUid ?? '');
const year = ref(now.getUTCFullYear());
const month = ref(now.getUTCMonth() + 1);

const loading = ref(false);
const error = ref<string | null>(null);
const report = ref<AttendanceMonthReport | null>(null);

const header = computed(() => report.value?.report ?? null);
const summary = computed(() => report.value?.month ?? null);
const statusLabel = computed(() => (header.value ? STATUS_LABEL[header.value.computationStatus] : ''));
const reasons = computed(() => (header.value?.statusReasons ?? []).map(describeReason));

async function load() {
  if (!employeeUid.value) {
    error.value = 'Missing employee context. Sign in again.';
    return;
  }
  loading.value = true;
  error.value = null;
  report.value = null;
  try {
    report.value = await api.attendanceMonthReport(employeeUid.value, year.value, month.value);
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'Failed to load the monthly report';
  } finally {
    loading.value = false;
  }
}

/** R-03: review mode has no backend, so exports must be refused rather than faked. */
const exportDisabledInReviewMode = isReviewFixtureMode;
const exporting = ref<AttendanceExportFormat | null>(null);
const exportError = ref<string | null>(null);

const canExport = computed(
  () =>
    Boolean(report.value)
    && Boolean(employeeUid.value)
    && !exportDisabledInReviewMode
    && exporting.value === null,
);

/**
 * Object URL + synthetic <a download> click.
 *
 * The object URL is revoked on a later task, NOT synchronously: the browser reads the blob after the click
 * handler returns, so revoking in the same tick can abort the download in some browsers. The revoke is
 * still unconditional, so no blob URL is leaked.
 */
function triggerDownload(file: AttendanceExportFile): void {
  const url = URL.createObjectURL(file.blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = file.fileName;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

async function download(format: AttendanceExportFormat): Promise<void> {
  if (!report.value || !employeeUid.value || exportDisabledInReviewMode) {
    return;
  }
  exporting.value = format;
  exportError.value = null;
  try {
    const file = await api.attendanceReportExport(
      employeeUid.value,
      'month',
      { year: year.value, month: month.value },
      format,
    );
    triggerDownload(file);
  } catch (e) {
    // Surface the failure WITHOUT clearing the already-loaded report.
    exportError.value =
      e instanceof ApiError ? `${e.code}: ${e.message}` : 'The export could not be downloaded.';
  } finally {
    exporting.value = null;
  }
}

onMounted(load);
</script>

<template>
  <section class="card">
    <div class="card-head">
      <h2>Monthly attendance</h2>
      <div class="inline-controls">
        <label class="field field--inline">
          <span>Year</span>
          <input v-model.number="year" type="number" min="2000" max="2100" />
        </label>
        <label class="field field--inline">
          <span>Month</span>
          <input v-model.number="month" type="number" min="1" max="12" />
        </label>
        <button type="button" class="btn btn--primary" :disabled="loading" @click="load">Load</button>
      </div>
    </div>

    <AsyncState :loading="loading" :error="error" :empty="!report && !loading && !error">
      <template v-if="header">
        <!-- The verdict comes BEFORE the figures: an incomplete month must say so first. -->
        <p v-if="!header.isFinal" class="review-banner" role="status">
          <strong>Not final — {{ statusLabel }}.</strong>
          These figures are incomplete and must not be read as a final result.
          <template v-if="reasons.length"> {{ reasons.join(' ') }}</template>
        </p>
        <p v-else class="hint">
          <span class="badge">{{ statusLabel }}</span>
          Every day included in this month was judged.
        </p>

        <dl v-if="summary" class="detail-grid" :class="{ muted: !header.isFinal }">
          <div><dt>Present</dt><dd>{{ summary.totalPresent }} / {{ summary.totalWorkDays }}</dd></div>
          <div><dt>Late</dt><dd>{{ summary.totalLate }} ({{ summary.totalLateMinutes }} min)</dd></div>
          <div><dt>Absent</dt><dd>{{ summary.totalAbsent }}</dd></div>
          <div><dt>Leave</dt><dd>{{ summary.totalLeave }}</dd></div>
          <div><dt>Work hours</dt><dd>{{ summary.totalWorkHours }}</dd></div>
          <div>
            <dt>Expected working days</dt>
            <dd>{{ summary.expectedWorkingDays ?? 'not derivable' }}</dd>
          </div>
        </dl>
        <!-- No stored row: show why instead of a fabricated month of zeros. -->
        <p v-else class="state state--empty">
          This month has never been derived, so there are no figures to show.
        </p>

        <dl class="detail-grid">
          <div><dt>Rule version</dt><dd>{{ header.ruleVersions.join(', ') || '—' }}</dd></div>
          <div><dt>Date cutoff</dt><dd>{{ header.dateCutoff ?? '—' }}</dd></div>
          <div><dt>Days included</dt><dd>{{ header.population.dayRows }}</dd></div>
        </dl>

        <div v-if="header.caveats.length" class="hint muted">
          <p v-for="caveat in header.caveats" :key="caveat.code">{{ caveat.detail }}</p>
        </div>
      </template>
    </AsyncState>

    <div class="export-panel">
      <h3>Export report</h3>
      <div class="inline-controls">
        <button
          type="button"
          class="btn btn--primary"
          :disabled="!canExport"
          :aria-busy="exporting === 'pdf'"
          @click="download('pdf')"
        >
          {{ exporting === 'pdf' ? 'Preparing PDF…' : 'Download PDF' }}
        </button>
        <button
          type="button"
          class="btn btn--ghost"
          :disabled="!canExport"
          :aria-busy="exporting === 'xlsx'"
          @click="download('xlsx')"
        >
          {{ exporting === 'xlsx' ? 'Preparing XLSX…' : 'Download XLSX' }}
        </button>
      </div>

      <p v-if="exportDisabledInReviewMode" class="hint muted" role="status">
        Exports need the API; review mode has no backend, so downloading is disabled here.
      </p>
      <p v-else-if="!report" class="hint muted">Load a month first to enable the downloads.</p>
      <p v-else-if="header && !header.isFinal" class="review-banner" role="status">
        <strong>DRAFT export.</strong>
        This month is not final ({{ statusLabel }}), so the downloaded file will carry a
        <strong>DRAFT</strong> watermark and the note
        <span lang="th">ข้อมูลยังไม่สมบูรณ์</span>, because the data is incomplete.
      </p>

      <p v-if="exportError" class="form-error" role="alert">{{ exportError }}</p>
    </div>
  </section>
</template>
