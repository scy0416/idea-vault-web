export interface Note {
  /** 만든 시각 14자리 YYYYMMDDHHmmss */
  id: string;
  text: string;
  tags: string[];
}

export interface Link {
  from: string;
  to: string;
  why: string;
}
