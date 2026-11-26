// Speech drafts and host transitions ("讲词 / 串词") for the meeting assistant.
//
// Two different jobs, deliberately kept apart:
//
//  - 讲词 (the content of the user's own sessions) is written once, before the
//    meeting, from the agenda.  That is buildScriptSystemPrompt below.
//  - 串词 (the words that carry the meeting: opening, transitions between
//    sessions, closing) is written just in time, a couple of minutes before the
//    moment it is needed, with the agenda *and* what was actually said so far.
//    That is buildCueSystemPrompt below, and the role decides its shape: a host
//    summarises the last session and introduces the next one, while a speaker
//    or panelist only thanks the host for the introduction.
//
// Pure helpers only, so scripts/selftest.mjs can verify them offline.

import { formatAgendaEntry } from './agenda.mjs';

/** Roles decide what the user actually has to say. */
export const ROLES = Object.freeze({
  host: '主持人',
  speaker: '讲者',
  panelist: '讨论嘉宾',
  attendee: '参会者'
});

export function roleLabel(role) {
  return isRole(role) ? ROLES[role] : '未设置角色';
}

export function isRole(value) {
  return typeof value === 'string' && Object.hasOwn(ROLES, value);
}

/** Upper bound for the user-edited writing instructions. */
export const MAX_PROMPT_CHARS = 4000;

/**
 * Default writing instructions for the user's own draft.  The client shows
 * this as the placeholder of the prompt editor; an empty user prompt means
 * "use this text".
 *
 * The draft is meant to be read out loud, so the instructions ask for natural
 * paragraphs instead of a bullet-point skeleton.
 */
export const DEFAULT_SCRIPT_PROMPT = [
  '请以第一人称「我」撰写我要在会议上说的讲词，只写属于我的部分：',
  '',
  '我的讲词',
  '讲词是直接照读的发言，不是提纲。每个环节按「开场 → 正文 → 收尾」写成一到四段连贯的自然段落：开场一段自然引入这一环节的主题和意义；正文用若干段把我要讲的内容说清楚，段与段之间用口语自然过渡；收尾一段做小结，并可以自然带出下一步。',
  '不要分条罗列，不要用「首先 / 其次 / 最后」的编号结构，也不要用公文体；读起来要像正常说话。',
  '不要写串词：串词由插件在接近我的环节时单独生成。',
  '',
  '通用要求：',
  '简体中文，正式但口语化；不要空话套话，不要编造日程里没有的信息。',
  '每段讲词 120–300 字。',
  '日程里的时间、姓名、单位必须原样保留，并且只为我出现的环节写稿。'
].join('\n');

/**
 * Default writing instructions when the user is the host.  The host draft is
 * not "my own slot": it has to carry the meeting, so it asks for the opening,
 * the transitions between sessions and the closing.
 */
export const DEFAULT_HOST_SCRIPT_PROMPT = [
  '请以第一人称「我」撰写我作为主持人要说的主持词：开场白、环节之间的衔接串词、结束语。',
  '',
  '我的主持词',
  '主持词是直接照读的话，不是提纲。每一段都用连贯的自然段落写，不要分条罗列，也不要用公文体。',
  '开场白：欢迎参会者，交代会议背景，并按日程顺序简要介绍今天的议程。',
  '环节衔接：在环节之间自然过渡——先承接上一环节真实讲过的内容，再介绍下一环节的主题和讲者/讨论嘉宾。',
  '结束语：回顾会议主线，致谢讲者与参会者，有后续安排才写。',
  '会议进行中重新生成时，如果给了实时转写或纪要，每个衔接都要点名总结上一环节各发言人的真实观点（多人讨论按嘉宾分别衔接）；没有转写就按日程写过渡，不要编造讨论内容。',
  '',
  '通用要求：',
  '简体中文，正式但口语化，像主持人正常说话；不要空话套话，不要编造日程里没有的信息。',
  '每段 120–300 字。',
  '日程里的时间、姓名、单位必须原样保留。'
].join('\n');

/** Names compare after removing whitespace and typographic separators. */
export function normalizePersonName(value) {
  return String(value ?? '').replace(/[\s·•・]/g, '').trim().toLowerCase();
}

/**
 * True when the agenda speaker looks like the configured user.  This is a
 * display/prompt hint only: the model still sees every entry and decides.
 */
export function nameMatches(speaker, userName) {
  const left = normalizePersonName(speaker);
  const right = normalizePersonName(userName);
  if (left.length === 0 || right.length === 0) return false;
  return left === right || left.includes(right) || right.includes(left);
}

/**
 * Annotate agenda entries with an `mine` flag for the user's own slots.
 * @param {Array<object>} entries
 * @param {string} userName
 * @returns {Array<{ index: number, entry: object, mine: boolean }>}
 */
export function markAgendaEntries(entries, userName) {
  return (Array.isArray(entries) ? entries : []).map((entry, index) => ({
    index,
    entry,
    mine: nameMatches(entry?.speaker, userName)
  }));
}

/**
 * A numbered agenda for the prompt, with the user's own slots marked.
 * @param {Array<object>} entries
 * @param {string} userName
 * @param {number} [limit]
 */
export function formatScriptAgenda(entries, userName, limit = 80) {
  return markAgendaEntries(entries, userName)
    .slice(0, limit)
    .map(({ entry, index, mine }) => `${index + 1}. ${formatAgendaEntry(entry)}${mine ? ' ［我的环节］' : ''}`)
    .join('\n');
}

/** Keep the tail of a long prompt input: in a live meeting the latest words matter most. */
export function tailText(value, limit = 12000) {
  const text = String(value ?? '');
  return text.length > limit ? text.slice(text.length - limit) : text;
}

/** "张医生（市医院）、李主任（省医院）" for one session's participants. */
export function formatParticipants(entry) {
  const people = Array.isArray(entry?.participants) ? entry.participants : [];
  return people
    .filter((person) => person && (person.name || person.org))
    .map((person) => `${person.name ?? ''}${person.org ? `（${person.org}）` : ''}`)
    .join('、');
}

/**
 * Structured agenda rendering for the prompts.  One session may list several
 * participants; they are rendered on their own line so the model never treats
 * "张医生、李主任" as a single person.  Only `entries` is ever used — the raw
 * text of the agenda box is not part of the prompt.
 *
 * @param {Array<object>} entries
 * @param {object} [options]
 * @param {string} [options.userName] mark the user's own sessions
 * @param {boolean} [options.markMine]
 * @param {number} [options.limit]
 * @returns {string}
 */
export function formatStructuredAgenda(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const userName = String(options.userName ?? '').trim();
  const markMine = options.markMine === true;
  const limit = Number.isFinite(Number(options.limit)) ? Number(options.limit) : 80;
  return list.slice(0, limit).map((entry, index) => {
    const marker = markMine && nameMatches(entry?.speaker, userName) ? ' ［我的环节］' : '';
    const line = `${index + 1}. ${formatAgendaEntry(entry)}${marker}`;
    const people = Array.isArray(entry?.participants) ? entry.participants : [];
    if (people.length > 1) return `${line}\n   参与人：${formatParticipants(entry)}`;
    return line;
  }).join('\n');
}

/**
 * Build the system prompt for one user-only draft.
 *
 * Two shapes, decided by `role`:
 *
 *  - host: the whole meeting is theirs — opening, the transitions between
 *    sessions and the closing.  With a live transcript/summary the transitions
 *    must summarise what each speaker actually said; without one they stay a
 *    framework built from the structured agenda (never invented content).
 *  - everyone else: only their own sessions, exactly as before.  Transitions
 *    are not written here; the cue card covers them.
 *
 * The agenda is rendered from `entries` only; the raw text of the agenda box is
 * never part of the prompt.
 *
 * @param {object} options
 * @param {Array<object>} options.entries parsed agenda entries
 * @param {string} [options.role] 'host' | 'speaker' | 'panelist' | 'attendee'
 * @param {string} [options.userName] the durable local profile name; for a host
 *   it is recommended but not required to match an agenda entry.
 * @param {string} [options.userOrg]
 * @param {string} [options.title] meeting title
 * @param {string} [options.date] meeting date, as shown to the user
 * @param {string} [options.topic] meeting topic
 * @param {string} [options.nowClock] current wall clock, "HH:MM"
 * @param {string} [options.transcript] recognized content so far (host only)
 * @param {string} [options.summary] running minutes (host only)
 * @param {string} [options.domainLabel] human label of the meeting domain
 * @param {string} [options.domainHint]
 * @param {string} [options.glossary] user glossary, for consistent wording
 * @param {string} [options.prompt] user-edited writing instructions
 * @returns {string}
 */
export function buildScriptSystemPrompt(options = {}) {
  const entries = Array.isArray(options.entries) ? options.entries : [];
  const role = isRole(options.role) ? options.role : 'speaker';
  const isHost = role === 'host';
  const userName = String(options.userName ?? '').trim();
  const userOrg = String(options.userOrg ?? '').trim();
  const title = String(options.title ?? '').trim();
  const date = String(options.date ?? '').trim();
  const topic = String(options.topic ?? '').trim();
  const nowClock = String(options.nowClock ?? '').trim();
  const domainLabel = String(options.domainLabel ?? '').trim();
  const domainHint = String(options.domainHint ?? '').trim();
  const glossary = String(options.glossary ?? '').trim().slice(0, 1200);
  const transcript = tailText(options.transcript, 12000);
  const summary = tailText(options.summary, 6000);
  const custom = String(options.prompt ?? '').trim().slice(0, MAX_PROMPT_CHARS);
  const instructions = custom.length > 0
    ? custom
    : (isHost ? DEFAULT_HOST_SCRIPT_PROMPT : DEFAULT_SCRIPT_PROMPT);
  const mine = entries.filter((entry) => nameMatches(entry?.speaker, userName));
  const mineText = mine.map((entry) => formatAgendaEntry(entry)).join('\n');
  const agendaText = formatStructuredAgenda(entries, { userName, markMine: !isHost });
  const infoLines = [
    '会议信息：',
    `- 会议标题：${title || '未提供'}`,
    date ? `- 会议日期：${date}` : '',
    `- 会议主题：${topic || '未提供'}`,
    `- 会议领域：${domainLabel || '通用会议'}${domainHint ? `（${domainHint}）` : ''}`,
    nowClock ? `- 当前时间：${nowClock}` : '',
    `- 我的姓名：${userName}${userOrg ? `（${userOrg}）` : ''}`,
    `- 我的角色：${roleLabel(role)}`,
    glossary.length > 0 ? `- 术语表（写稿时必须采用这些写法）：\n${glossary}` : ''
  ].filter(Boolean);

  if (isHost) {
    return [
      '你是这场会议的主持人，正在为自己准备可以直接照读的主持词：开场白、环节之间的衔接串词、结束语。',
      '',
      ...infoLines,
      '',
      '会议日程（结构化，按这个顺序推进；多人环节会单独列出参与人）：',
      agendaText || '（日程为空）',
      '',
      transcript
        ? `已有的会议转写（实时识别，可能有错别字；写衔接时用来总结上一环节真实讲过的话，按姓名区分发言人）：\n${transcript}`
        : '（会议还没有识别到内容：衔接按日程写过渡框架，不要虚构上一环节的发言内容）',
      summary ? `\n当前会议纪要（供参考）：\n${summary}` : '',
      '',
      '输出结构（自然 Markdown，不要用分条清单）：',
      '## 开场白',
      '（一段可直接照读的欢迎词：会议背景 + 今天的议程概览）',
      '## 环节衔接',
      '### <上一环节> 到 <下一环节>',
      '（按日程顺序，每个环节之间写一段；最后一段是进入最后一个环节的衔接）',
      '## 结束语',
      '（一段可直接照读的收尾）',
      '',
      '写作要求：',
      instructions,
      '',
      '规则：',
      '1. 开场白：欢迎参会者，交代会议背景，并按上面日程的顺序简要概览今天的议程，把第一个环节及其讲者介绍出去；只写确认过的信息，没有的就概括带过。',
      '2. 环节衔接：先用自然的话承接并总结上一环节真实讲过的内容，再介绍即将开始的环节主题、讲者或讨论嘉宾；多人讨论的环节要按嘉宾分别衔接，用姓名自然带出，不要把不同人的话混在一起。',
      transcript.length > 0 || summary.length > 0
        ? '3. 上面有实时转写或纪要时，每个衔接都要点名总结上一环节各发言人真正讲过的观点；严禁编造转写里没有的发言、数字或结论。'
        : '3. 现在还没有实时转写或纪要：衔接只按日程写过渡（上一环节的主题、下一环节的主题和讲者），不要虚构上一环节讲了什么。',
      '4. 结束语：按发言人和环节回顾会议真实主线（有转写/纪要时依据它们），致谢讲者与参会者；后续安排、联系方式等只在日程或信息里有时才写。',
      '5. 这是主持人自己的话：用第一人称「我」，只写我作为主持人要说的话，不要替讲者拟稿，不要写别人的发言内容。',
      '6. 每段 120–300 字；正式但口语化，可以直接照读；不要分条罗列，不要用公文体。',
      '7. 输出 Markdown，不要用代码块包裹整篇。'
    ].filter(Boolean).join('\n');
  }

  return [
    '你是一名资深会议发言撰稿人，只为参会者「我」准备可以直接照读的讲词：只有我要讲的内容。',
    '',
    ...infoLines,
    '',
    '会议日程（编号. 时间 讲者/单位：主题；多人环节单独列出参与人；［我的环节］表示记在我名下）：',
    agendaText || '（日程为空）',
    '',
    '我负责的环节：',
    mineText || '（无）',
    '',
    '写作要求：',
    instructions,
    '',
    '输出格式（自然 Markdown，不要用代码块包裹整篇）：',
    '## 我的讲词',
    '### <时间> <我的环节主题>',
    '（开场一段，直接照读）',
    '（正文若干段，连贯的口语段落）',
    '（收尾一段）',
    '',
    '规则：',
    '1. 只输出我的讲词：不属于我的环节不要写，也不要替别人拟稿，不要写串词。',
    '2. 只使用上面日程、我的信息和术语表里出现过的事实；缺信息就写得概括，不要编造具体数字、人名或结论。',
    '3. 时间、姓名、单位与日程完全一致；不要给日程之外的人安排环节。',
    '4. 用第一人称「我」，像正常说话一样，不要写成提纲或公文体。'
  ].filter(Boolean).join('\n');
}

/**
 * The user turn that accompanies the system prompt.
 * @param {object} options
 * @param {string} [options.topic]
 * @param {string} [options.role]
 * @returns {string}
 */
export function buildScriptUserPrompt(options = {}) {
  const topic = String(options.topic ?? '').trim();
  const role = isRole(options.role) ? options.role : 'speaker';
  return [
    topic.length > 0 ? `会议主题：${topic}` : '',
    role === 'host'
      ? '请根据会议日程生成「我的主持词」：开场白、各环节之间的衔接、结束语，严格按输出格式返回 Markdown。'
      : '请根据会议日程生成「我的讲词」，只写我负责的环节，严格按输出格式返回 Markdown。'
  ].filter(Boolean).join('\n');
}

/* ------------------------------------------------------------------------ */
/* 串词 (cue) — one card per moment, generated just in time                  */
/* ------------------------------------------------------------------------ */

/**
 * What a cue episode means for this user.
 *
 *  opening    the host opens the meeting
 *  transition the host hands the floor to the next session
 *  closing    the host closes the meeting
 *  thanks     a speaker/panelist thanks the host for the introduction
 *  manual     the user asked for a cue at this point
 */
export function cueKindFor(role, entry, prevEntry, nextEntry) {
  if (role === 'host') {
    if (!prevEntry && nextEntry) return 'opening';
    if (prevEntry && !nextEntry) return 'closing';
    return 'transition';
  }
  return 'thanks';
}

/** Minutes since midnight for "now". */
export function minutesOfDay(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * Which cue moments are due right now.
 *
 * The rule the operator asked for: a cue is produced about two minutes before
 * the user has to speak, and never earlier than that, so it can use what was
 * actually said.  `window` is [start - lead, start + grace].
 *
 * @param {object} options
 * @param {Array<object>} options.entries
 * @param {string} options.role
 * @param {string} options.userName
 * @param {number} options.minutes minutes of day
 * @param {number} [options.lead] minutes before the slot (default 2)
 * @param {number} [options.grace] minutes after the slot start (default 12)
 * @returns {Array<{ key: string, index: number, kind: string }>}
 */
export function dueCues(options = {}) {
  const entries = Array.isArray(options.entries) ? options.entries : [];
  const role = isRole(options.role) ? options.role : 'speaker';
  const userName = String(options.userName ?? '').trim();
  const minutes = Number(options.minutes);
  const lead = Number.isFinite(Number(options.lead)) ? Number(options.lead) : 2;
  const grace = Number.isFinite(Number(options.grace)) ? Number(options.grace) : 12;
  if (!Number.isFinite(minutes) || entries.length === 0) return [];
  const timed = entries
    .map((entry, index) => ({ entry, index }))
    .filter((item) => item.entry && item.entry.startMin !== null && item.entry.startMin !== undefined);
  if (timed.length === 0) return [];
  const due = [];
  const inWindow = (startMin) => minutes >= startMin - lead && minutes <= startMin + grace;

  if (role === 'host') {
    const first = timed[0];
    if (inWindow(first.entry.startMin)) {
      due.push({ key: 'open', index: first.index, kind: 'opening' });
    }
    for (const item of timed) {
      if (!inWindow(item.entry.startMin)) continue;
      const position = timed.findIndex((candidate) => candidate.index === item.index);
      // The opening already introduces the first session; a second card for it
      // would just repeat the welcome.
      if (position === 0) continue;
      const prev = position > 0 ? timed[position - 1].entry : null;
      const next = position < timed.length - 1 ? timed[position + 1].entry : null;
      const kind = cueKindFor(role, item.entry, prev, next);
      due.push({ key: `entry:${item.index}`, index: item.index, kind });
    }
    const last = timed[timed.length - 1];
    const endMin = Number(last.entry.endMin ?? last.entry.startMin + 30);
    if (minutes >= endMin - lead && minutes <= endMin + grace) {
      due.push({ key: 'close', index: last.index, kind: 'closing' });
    }
    return due;
  }

  if (role === 'speaker' || role === 'panelist') {
    for (const item of timed) {
      if (!nameMatches(item.entry.speaker, userName)) continue;
      if (!inWindow(item.entry.startMin)) continue;
      due.push({ key: `own:${item.index}`, index: item.index, kind: 'thanks' });
    }
    return due;
  }

  return [];
}

/**
 * The system prompt for one cue card.
 *
 * A cue card is read out loud the moment before the user speaks, so it is
 * plain text, short and conversational.  The host version also has to carry
 * the live meeting: what each speaker actually said in the session that just
 * ended (named, from the transcript) and who is coming up next (from the
 * structured agenda).  Without a transcript it writes a framework from the
 * agenda only and never invents discussion content.
 *
 * @param {object} options
 * @param {string} options.kind opening | transition | closing | thanks | manual
 * @param {string} options.role
 * @param {object} [options.entry] the session the cue leads into
 * @param {object} [options.prevEntry] the session that just ended
 * @param {object} [options.nextEntry] the session after `entry`
 * @param {Array<object>} options.entries full agenda (structured)
 * @param {string} [options.userName]
 * @param {string} [options.userOrg]
 * @param {string} [options.title] meeting title
 * @param {string} [options.date] meeting date
 * @param {string} [options.topic]
 * @param {string} [options.domainLabel]
 * @param {string} [options.domainHint]
 * @param {string} [options.glossary]
 * @param {string} [options.transcript] what was said so far (may be empty)
 * @param {string} [options.summary] running minutes, if any
 * @param {string} [options.nowClock] "HH:MM" of the moment
 * @returns {string}
 */
export function buildCueSystemPrompt(options = {}) {
  const kind = String(options.kind ?? 'transition');
  const role = isRole(options.role) ? options.role : 'speaker';
  const entries = Array.isArray(options.entries) ? options.entries : [];
  const userName = String(options.userName ?? '').trim();
  const userOrg = String(options.userOrg ?? '').trim();
  const title = String(options.title ?? '').trim();
  const date = String(options.date ?? '').trim();
  const topic = String(options.topic ?? '').trim();
  const domainLabel = String(options.domainLabel ?? '').trim();
  const domainHint = String(options.domainHint ?? '').trim();
  const nowClock = String(options.nowClock ?? '').trim();
  const glossary = String(options.glossary ?? '').trim().slice(0, 800);
  const transcript = tailText(options.transcript, 9000).trim();
  const summary = tailText(options.summary, 4000).trim();
  const entryText = options.entry ? formatAgendaEntry(options.entry) : '';
  const prevText = options.prevEntry ? formatAgendaEntry(options.prevEntry) : '';
  const nextText = options.nextEntry ? formatAgendaEntry(options.nextEntry) : '';
  const agendaText = formatStructuredAgenda(entries, { limit: 40 });
  const infoLines = [
    '会议信息：',
    `- 会议标题：${title || '未提供'}`,
    date ? `- 会议日期：${date}` : '',
    `- 会议主题：${topic || '未提供'}`,
    `- 会议领域：${domainLabel || '通用会议'}${domainHint ? `（${domainHint}）` : ''}`,
    `- 当前时间：${nowClock || '未提供'}`,
    `- 我的角色：${roleLabel(role)}`,
    glossary.length > 0 ? `- 术语表（必须采用这些写法）：\n${glossary}` : ''
  ].filter(Boolean);

  if (kind === 'thanks') {
    return [
      `你是一名${domainLabel || '会议'}现场发言顾问。我是「${userName}」${userOrg ? `（${userOrg}）` : ''}，在这场会议里的角色是${roleLabel(role)}。`,
      '',
      '现在轮到我上场，我只需要一段很短的开场回应：感谢主持人的介绍，简短自我介绍（姓名/单位，只用已给信息），然后把话头交给我的内容。',
      '',
      ...infoLines,
      '',
      '完整日程（只用来知道我紧接着哪个环节上场，不要在串词里介绍别人）：',
      agendaText || '（日程为空）',
      '',
      '规则：',
      '1. 只写 1–2 句，30–60 字，口语化，可以直接照读。',
      '2. 不要写讲稿正文，不要总结会议，不要介绍别人，不要编造事实。',
      '3. 称呼主持人时用「主持人」即可，不要编造姓名。',
      '4. 输出纯文本，不要标题、不要 markdown 代码块、不要 bullet 列表。',
      '',
      entryText ? `我要讲的环节：${entryText}` : ''
    ].filter(Boolean).join('\n');
  }

  const kindInstruction = kind === 'opening'
    ? '现在是会议开场：欢迎参会者，交代会议背景，并简要概览今天的议程，把第一个环节和讲者介绍出去。'
    : kind === 'closing'
      ? '现在是会议结束：按发言人和环节回顾今天真实讲过的内容，致谢并交代后续安排（没有信息就不要编）。'
      : prevText
        ? '现在上一个环节刚刚结束，我要把场子交给下一个环节。'
        : '现在我要把场子交给这个环节。';

  const rules = kind === 'opening'
    ? [
      '1. 欢迎参会者，交代会议背景，并按上面日程的顺序简要概览今天的议程；把第一个环节的主题和讲者介绍出去。',
      '2. 口语化，可以直接照读；总长 60–180 字。',
      '3. 只说确认过的信息，不要编造；不要写别人的讲稿，不要用 bullet 列表。',
      '4. 输出纯文本，不要标题、不要 markdown 代码块。'
    ]
    : kind === 'closing'
      ? [
        '1. 按发言人和环节回顾今天真实讲过的内容，只能依据下面的转写或纪要；没有内容就概括会议主线，绝不编造。',
        '2. 致谢讲者、讨论嘉宾与参会者；后续安排、联系方式、下次会议等信息只在上面给到或日程里有时才写。',
        '3. 口语化，可以直接照读；总长 60–180 字。',
        '4. 不要写别人的讲稿，不要用 bullet 列表，不要标题；输出纯文本。'
      ]
      : [
        '1. 先用自然的一两句话承接并总结刚刚结束环节里真实讲过的内容：只能依据下面的实时转写或纪要，点名发言人各自说了什么；没有内容时就礼貌带过，绝不编造。',
        '2. 多人讨论的环节要按嘉宾分别衔接：谁先讲了什么观点、谁补充了什么，用姓名自然带出，不要把不同人的话混在一起。',
        '3. 再介绍即将开始的环节：主题、讲者或讨论嘉宾的姓名和单位（与日程一致）；如果下一环节是多人讨论，把嘉宾逐个介绍出来，并交代讨论怎么进行（例如请谁先发言、之后如何互动）。',
        '4. 口语化，可以直接照读；总长 60–180 字。',
        '5. 不要写别人的讲稿，不要写我没有说过的事实，不要用 bullet 列表。',
        '6. 输出纯文本，不要标题、不要 markdown 代码块。'
      ];

  const momentLines = kind === 'closing'
    ? [
      entryText ? `最后一个环节：${entryText}` : '',
      prevText ? `它之前是：${prevText}` : ''
    ]
    : [
      prevText ? `刚刚结束的环节：${prevText}` : '',
      entryText ? `即将开始的环节：${entryText}` : '',
      nextText ? `它之后还有：${nextText}` : ''
    ];

  return [
    `你是一名资深会议主持人，我是「${userName}」${userOrg ? `（${userOrg}）` : ''}，这场会议的${roleLabel(role)}。`,
    '请写我此刻要说的一段串词：直接照读的话，不是提纲。',
    '',
    ...infoLines,
    '',
    '完整日程（结构化：时间、讲者/参与人、环节主题；多人环节单独列出参与人）：',
    agendaText || '（日程为空）',
    '',
    ...momentLines,
    '',
    kindInstruction,
    '',
    '内容与写法：',
    ...rules,
    '',
    transcript ? `已经识别到的会议内容（截至现在，可能有识别错误）：\n${transcript}` : '（会议刚开始，还没有识别到内容）',
    summary ? `\n当前会议纪要（供参考）：\n${summary}` : ''
  ].filter(Boolean).join('\n');
}

/**
 * The user turn for one cue card.
 * @param {object} options
 * @param {string} [options.nowClock] e.g. "14:28"
 * @param {string} [options.kind]
 * @returns {string}
 */
export function buildCueUserPrompt(options = {}) {
  const clock = String(options.nowClock ?? '').trim();
  const kind = String(options.kind ?? 'transition');
  const moment = kind === 'opening' ? '会议开场'
    : kind === 'closing' ? '会议结束'
      : kind === 'thanks' ? '我上场前'
        : '环节交接';
  return `现在时间 ${clock || '（未提供）'}，场合是「${moment}」。请只输出我这一刻要说的那段话。`;
}
