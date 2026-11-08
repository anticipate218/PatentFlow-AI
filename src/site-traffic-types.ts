export interface TrafficSnapshot {
  ok: true;
  timezone: 'Asia/Shanghai';
  startedAt: string | null;
  total: { views: number; visitors: number };
  today: { day: string; views: number; visitors: number };
}
