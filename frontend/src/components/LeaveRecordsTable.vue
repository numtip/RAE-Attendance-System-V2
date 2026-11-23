<script setup lang="ts">
import { leaveTypeLabel } from '../utils/i18n';
import { formatThaiDate, leaveRecordChipClass } from '../utils/thai';
import type { LeaveRow } from '../api/types';

defineProps<{ rows: LeaveRow[] }>();

function days(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
function dateText(row: LeaveRow): string {
  return row.startDate === row.endDate
    ? formatThaiDate(row.startDate)
    : `${formatThaiDate(row.startDate)} – ${formatThaiDate(row.endDate)}`;
}
</script>

<template>
  <div class="table-scroll">
    <table class="data-table data-table--stack">
      <thead>
        <tr><th>วันที่</th><th>ประเภท</th><th>ช่วงเวลา</th><th class="num">จำนวนวัน</th><th>สถานะ</th><th>แหล่งข้อมูล</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.leaveId">
          <td data-label="วันที่">{{ dateText(row) }}</td>
          <td data-label="ประเภท">{{ row.typeLabel ?? leaveTypeLabel(row.leaveType) }}</td>
          <td data-label="ช่วงเวลา">{{ row.partLabel ?? '—' }}</td>
          <td data-label="จำนวนวัน" class="num">{{ days(row.dayFraction) }}</td>
          <td data-label="สถานะ">
            <span :class="leaveRecordChipClass(row.status)">{{ row.statusLabel ?? row.status }}</span>
            <span v-if="row.reasonLabels?.length" class="muted"> {{ row.reasonLabels.join('; ') }}</span>
          </td>
          <td data-label="แหล่งข้อมูล">{{ row.sourceLabel ?? '—' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
