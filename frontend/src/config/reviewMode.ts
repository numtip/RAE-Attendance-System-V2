/**
 * Review/fixture build flag. Set VITE_REVIEW_MODE=true (or the legacy value "fixture") to serve static
 * fixture data and show the review banner / fixture credentials hint. Unset in production builds.
 */
const flag = import.meta.env.VITE_REVIEW_MODE;
export const isReviewFixtureMode = flag === 'true' || flag === 'fixture';

export const reviewModeBannerText =
  'โหมดตรวจสอบ: ใช้ข้อมูลตัวอย่างเท่านั้น (ไม่เชื่อมต่อระบบจริง) เข้าสู่ระบบด้วย user@example.test / valid-pass';
