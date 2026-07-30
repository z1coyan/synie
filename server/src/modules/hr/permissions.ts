/**
 * 日考勤权限常量：ResourceDefinition 与 service 鉴权共用，禁止字符串漂移。
 */
export const HR_ATTENDANCE_DAY = {
  prefix: 'hr.attendance_day',
  read: 'hr.attendance_day:read',
  /** 按区间重算（collection command） */
  recalc: 'hr.attendance_day:recalc',
} as const

export type HrAttendanceDayPermission =
  (typeof HR_ATTENDANCE_DAY)[keyof typeof HR_ATTENDANCE_DAY]
