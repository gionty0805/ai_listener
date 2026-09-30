// Claude Structured Outputs(output_config.format = json_schema)용 스키마.
// 구조화 출력 규칙: 모든 object 는 additionalProperties:false + 전 필드 required.
// "없음"은 빈 문자열/빈 배열로 표현한다(null 허용 대신).

const str = (description) => ({ type: 'string', description });
const strArr = (description) => ({ type: 'array', items: { type: 'string' }, description });
const obj = (properties) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

// ---- 청크 단위 중간 노트 (map 단계) ----
export const chunkNotesSchema = obj({
  summary: str('이 구간의 핵심 내용 요약 (3~6문장)'),
  topics: strArr('논의된 주제'),
  decisions: strArr('이 구간에서 확정된 결정사항'),
  action_items: {
    type: 'array',
    items: obj({
      task: str('할 일'),
      owner: str('담당자 (언급 없으면 빈 문자열)'),
      due: str('기한 원문 표현 또는 YYYY-MM-DD (없으면 빈 문자열)'),
      evidence_time: str('근거 발화 타임스탬프 [mm:ss]'),
    }),
  },
  schedules: {
    type: 'array',
    items: obj({
      title: str('일정 제목'),
      when: str('날짜/시간 원문 표현 또는 YYYY-MM-DD HH:mm'),
      evidence_time: str('근거 발화 타임스탬프'),
    }),
  },
  open_questions: strArr('결론이 나지 않은 이슈/질문'),
  notable_quotes: strArr('면접/회의 판단에 중요한 발화 원문 (타임스탬프 포함)'),
});

// ---- 회의 최종 요약 ----
export const meetingSummarySchema = obj({
  title: str('회의 제목 (입력 제목이 있으면 그대로, 없으면 내용 기반 생성)'),
  overview: str('회의 전체 개요 3~5문장'),
  key_points: strArr('핵심 논의 내용 (중요도 순)'),
  decisions: {
    type: 'array',
    items: obj({ decision: str('결정 내용'), rationale: str('결정 근거/배경 (없으면 빈 문자열)') }),
  },
  action_items: {
    type: 'array',
    items: obj({
      task: str('할 일 (동사로 끝나는 구체적 문장)'),
      owner: str('담당자 (불명확하면 "미정")'),
      due_date: str('YYYY-MM-DD 로 환산한 기한 (환산 불가/없음이면 빈 문자열)'),
      due_text: str('기한 원문 표현 (없으면 빈 문자열)'),
      priority: { type: 'string', enum: ['높음', '보통', '낮음'] },
    }),
  },
  schedules: {
    type: 'array',
    items: obj({
      title: str('일정명'),
      date: str('YYYY-MM-DD (환산 불가 시 빈 문자열)'),
      time: str('HH:mm 24시간제 (없으면 빈 문자열)'),
      description: str('일정 설명 및 원문 표현'),
    }),
  },
  open_issues: strArr('미결 이슈 / 추가 확인 필요 사항'),
  next_meeting: str('다음 회의 일정/안건 (언급 없으면 빈 문자열)'),
});

// ---- 면접 최종 평가 ----
export const interviewSummarySchema = obj({
  candidate_summary: str('지원자 경력/역량 요약 (대화에서 확인된 사실만)'),
  qa_log: {
    type: 'array',
    items: obj({ question: str('면접관 질문'), answer_summary: str('지원자 답변 요약'), time: str('타임스탬프') }),
  },
  competencies: {
    type: 'array',
    items: obj({
      name: str('평가 역량명 (평가 기준표의 항목과 동일하게)'),
      score: { type: 'integer', description: '1~5점. 근거 부족으로 판단 불가 시 0', enum: [0, 1, 2, 3, 4, 5] },
      assessment: str('평가 의견 (근거 기반)'),
      evidence: strArr('근거가 된 지원자 발화 인용 "[mm:ss] ..." 형식'),
    }),
  },
  strengths: strArr('강점'),
  concerns: strArr('우려 사항 / 검증 필요 사항'),
  follow_up_questions: strArr('다음 면접/레퍼런스 체크에서 확인할 질문'),
  recommendation: { type: 'string', enum: ['강력 추천', '추천', '보류', '비추천', '판단 불가'] },
  recommendation_rationale: str('종합 의견의 근거'),
  bias_check: obj({
    flags: strArr('평가에 개입될 수 있었던 직무 무관 요소(나이·성별·출신·외모·가족관계 등)가 대화에 등장한 경우 기록. 없으면 빈 배열'),
    note: str('편향 점검 메모'),
  }),
});

// ---- 경량 검증기: 구조화 출력은 스키마를 보장하지만, 폴백/모의 모드 대비 방어적으로 한 번 더 확인 ----
export function validate(schema, value, at = '$') {
  const errs = [];
  const t = schema.type;
  if (t === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${at}: object 필요`];
    for (const k of schema.required || []) if (!(k in value)) errs.push(`${at}.${k}: 누락`);
    for (const [k, sub] of Object.entries(schema.properties || {})) {
      if (k in value) errs.push(...validate(sub, value[k], `${at}.${k}`));
    }
  } else if (t === 'array') {
    if (!Array.isArray(value)) return [`${at}: array 필요`];
    value.forEach((v, i) => errs.push(...validate(schema.items, v, `${at}[${i}]`)));
  } else if (t === 'string') {
    if (typeof value !== 'string') errs.push(`${at}: string 필요`);
    else if (schema.enum && !schema.enum.includes(value)) errs.push(`${at}: 허용되지 않은 값 ${value}`);
  } else if (t === 'integer') {
    if (!Number.isInteger(value)) errs.push(`${at}: integer 필요`);
    else if (schema.enum && !schema.enum.includes(value)) errs.push(`${at}: 허용되지 않은 값 ${value}`);
  }
  return errs;
}
