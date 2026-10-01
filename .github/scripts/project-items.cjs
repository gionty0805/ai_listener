// GitHub Projects(v2) 아이템 관리: list / create / add-issue / update / archive / delete
// project-items.yml 워크플로에서 actions/github-script로 실행된다.
// github 클라이언트는 `project` 권한이 있는 PAT(PROJECT_TOKEN)로 인증된다.

const FIELDS_FRAGMENT = `
  fields(first: 50) {
    nodes {
      ... on ProjectV2FieldCommon { id name dataType }
      ... on ProjectV2SingleSelectField { options { id name } }
      ... on ProjectV2IterationField { configuration { iterations { id title startDate } } }
    }
  }`;

const FIELD_VALUE_FRAGMENT = `
  fieldValues(first: 30) {
    nodes {
      ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
      ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } }
      ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } }
      ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
      ... on ProjectV2ItemFieldIterationValue { title field { ... on ProjectV2FieldCommon { name } } }
    }
  }`;

async function getProject(github, ownerType, owner, number) {
  const root = ownerType === 'org' ? 'organization' : 'user';
  const res = await github.graphql(
    `query($owner: String!, $number: Int!) {
      ${root}(login: $owner) { projectV2(number: $number) { id title url ${FIELDS_FRAGMENT} } }
    }`,
    { owner, number },
  );
  const project = res[root]?.projectV2;
  if (!project) throw new Error(`프로젝트를 찾을 수 없습니다: ${owner} #${number}`);
  return project;
}

async function listItems(github, projectId) {
  const items = [];
  let after = null;
  do {
    const res = await github.graphql(
      `query($id: ID!, $after: String) {
        node(id: $id) {
          ... on ProjectV2 {
            items(first: 100, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id isArchived type
                content {
                  ... on DraftIssue { id title }
                  ... on Issue { title number url state }
                  ... on PullRequest { title number url state }
                }
                ${FIELD_VALUE_FRAGMENT}
              }
            }
          }
        }
      }`,
      { id: projectId, after },
    );
    const page = res.node.items;
    items.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return items;
}

async function getItem(github, itemId) {
  const res = await github.graphql(
    `query($id: ID!) {
      node(id: $id) {
        ... on ProjectV2Item {
          id type
          project { id }
          content { ... on DraftIssue { id title } ... on Issue { title number } ... on PullRequest { title number } }
        }
      }
    }`,
    { id: itemId },
  );
  if (!res.node?.id) throw new Error(`아이템을 찾을 수 없습니다: ${itemId}`);
  return res.node;
}

function fieldValueMap(item) {
  const out = {};
  for (const v of item.fieldValues?.nodes ?? []) {
    const name = v.field?.name;
    if (!name || name === 'Title') continue;
    out[name] = v.text ?? v.number ?? v.date ?? v.name ?? v.title;
  }
  return out;
}

function toFieldValue(field, raw) {
  const value = String(raw).trim();
  switch (field.dataType) {
    case 'TEXT':
      return { text: value };
    case 'NUMBER': {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`'${field.name}'은 숫자 필드입니다: ${value}`);
      return { number: n };
    }
    case 'DATE':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`'${field.name}'은 날짜(YYYY-MM-DD) 필드입니다: ${value}`);
      return { date: value };
    case 'SINGLE_SELECT': {
      const opt = field.options.find((o) => o.name.toLowerCase() === value.toLowerCase());
      if (!opt) throw new Error(`'${field.name}'에 '${value}' 옵션이 없습니다. 가능: ${field.options.map((o) => o.name).join(', ')}`);
      return { singleSelectOptionId: opt.id };
    }
    case 'ITERATION': {
      const it = field.configuration.iterations.find((i) => i.title.toLowerCase() === value.toLowerCase());
      if (!it) throw new Error(`'${field.name}'에 '${value}' 이터레이션이 없습니다.`);
      return { iterationId: it.id };
    }
    default:
      throw new Error(`'${field.name}'(${field.dataType}) 필드는 이 워크플로에서 수정할 수 없습니다.`);
  }
}

// fields: {"Status": "In Progress", "Priority": "High", "Due": "2026-10-31"} — 값이 null 또는 ""이면 비운다.
// 변경 전에 모든 필드를 먼저 검증해, 잘못된 입력으로 일부만 반영되는 일을 막는다.
function resolveFields(project, fields) {
  return Object.entries(fields).map(([name, raw]) => {
    const field = project.fields.nodes.find((f) => f.name?.toLowerCase() === name.toLowerCase());
    if (!field) throw new Error(`필드를 찾을 수 없습니다: ${name}. 가능: ${project.fields.nodes.map((f) => f.name).filter(Boolean).join(', ')}`);
    const clear = raw === null || String(raw).trim() === '';
    return { field, raw, value: clear ? null : toFieldValue(field, raw) };
  });
}

async function setFields(github, project, itemId, resolved) {
  const changed = [];
  for (const { field, raw, value } of resolved) {
    if (value === null) {
      await github.graphql(
        `mutation($p: ID!, $i: ID!, $f: ID!) {
          clearProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i, fieldId: $f }) { projectV2Item { id } }
        }`,
        { p: project.id, i: itemId, f: field.id },
      );
      changed.push(`${field.name} = (비움)`);
      continue;
    }
    await github.graphql(
      `mutation($p: ID!, $i: ID!, $f: ID!, $v: ProjectV2FieldValue!) {
        updateProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i, fieldId: $f, value: $v }) { projectV2Item { id } }
      }`,
      { p: project.id, i: itemId, f: field.id, v: value },
    );
    changed.push(`${field.name} = ${raw}`);
  }
  return changed;
}

function parseFields(json) {
  if (!json || !json.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`fields는 JSON 객체여야 합니다. 예: {"Status":"Todo"} — 받은 값: ${json}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('fields는 JSON 객체여야 합니다.');
  return parsed;
}

function requireInput(value, name) {
  if (!value || !String(value).trim()) throw new Error(`이 작업에는 '${name}' 입력이 필요합니다.`);
  return String(value).trim();
}

function assertSameProject(item, project) {
  if (item.project?.id !== project.id) throw new Error('해당 아이템은 이 프로젝트에 속하지 않습니다.');
}

module.exports = async ({ github, context, core }) => {
  const env = process.env;
  const action = env.INPUT_ACTION;
  const project = await getProject(github, env.PROJECT_OWNER_TYPE, env.PROJECT_OWNER, Number(env.PROJECT_NUMBER));
  const fields = resolveFields(project, parseFields(env.INPUT_FIELDS));
  core.info(`프로젝트: ${project.title} (${project.url}) / 작업: ${action}`);

  const summary = core.summary.addHeading(`Project: ${project.title} — ${action}`, 3);
  let result;

  switch (action) {
    case 'list': {
      const items = await listItems(github, project.id);
      const rows = items
        .filter((i) => env.INPUT_INCLUDE_ARCHIVED === 'true' || !i.isArchived)
        .map((i) => ({
          item_id: i.id,
          type: i.type,
          number: i.content?.number ?? null,
          title: i.content?.title ?? '(제목 없음)',
          archived: i.isArchived,
          fields: fieldValueMap(i),
        }));
      // 로그에서 기계적으로 읽을 수 있도록 JSON 한 줄로 출력
      core.info(`ITEMS_JSON=${JSON.stringify(rows)}`);
      summary.addTable([
        [{ data: 'item_id', header: true }, { data: 'type', header: true }, { data: '#', header: true }, { data: 'title', header: true }, { data: 'fields', header: true }],
        ...rows.map((r) => [r.item_id, r.type, r.number ? String(r.number) : '', r.title, JSON.stringify(r.fields)]),
      ]);
      const fieldsInfo = project.fields.nodes
        .filter((f) => f.name)
        .map((f) => `${f.name} (${f.dataType})${f.options ? ': ' + f.options.map((o) => o.name).join(' / ') : ''}`);
      core.info(`FIELDS=${JSON.stringify(fieldsInfo)}`);
      summary.addList(fieldsInfo);
      result = { count: rows.length };
      break;
    }

    case 'create': {
      const res = await github.graphql(
        `mutation($p: ID!, $t: String!, $b: String) {
          addProjectV2DraftIssue(input: { projectId: $p, title: $t, body: $b }) { projectItem { id } }
        }`,
        { p: project.id, t: requireInput(env.INPUT_TITLE, 'title'), b: env.INPUT_BODY || null },
      );
      const itemId = res.addProjectV2DraftIssue.projectItem.id;
      const changed = await setFields(github, project, itemId, fields);
      result = { item_id: itemId, changed };
      break;
    }

    case 'add-issue': {
      const number = Number(requireInput(env.INPUT_ISSUE_NUMBER, 'issue_number'));
      const res = await github.graphql(
        `query($o: String!, $r: String!, $n: Int!) {
          repository(owner: $o, name: $r) { issueOrPullRequest(number: $n) { ... on Issue { id } ... on PullRequest { id } } }
        }`,
        { o: context.repo.owner, r: context.repo.repo, n: number },
      );
      const contentId = res.repository.issueOrPullRequest?.id;
      if (!contentId) throw new Error(`이슈/PR #${number}을 찾을 수 없습니다.`);
      const added = await github.graphql(
        `mutation($p: ID!, $c: ID!) { addProjectV2ItemById(input: { projectId: $p, contentId: $c }) { item { id } } }`,
        { p: project.id, c: contentId },
      );
      const itemId = added.addProjectV2ItemById.item.id;
      const changed = await setFields(github, project, itemId, fields);
      result = { item_id: itemId, issue_number: number, changed };
      break;
    }

    case 'update': {
      const itemId = requireInput(env.INPUT_ITEM_ID, 'item_id');
      const item = await getItem(github, itemId);
      assertSameProject(item, project);
      const changed = [];
      if (env.INPUT_TITLE || env.INPUT_BODY) {
        if (item.type !== 'DRAFT_ISSUE') throw new Error('title/body는 드래프트 아이템만 수정할 수 있습니다. 이슈는 이슈에서 직접 수정하세요.');
        const input = { draftIssueId: item.content.id };
        if (env.INPUT_TITLE) input.title = env.INPUT_TITLE;
        if (env.INPUT_BODY) input.body = env.INPUT_BODY;
        await github.graphql(
          `mutation($input: UpdateProjectV2DraftIssueInput!) { updateProjectV2DraftIssue(input: $input) { draftIssue { id } } }`,
          { input },
        );
        changed.push(...Object.keys(input).filter((k) => k !== 'draftIssueId'));
      }
      changed.push(...(await setFields(github, project, itemId, fields)));
      if (!changed.length) throw new Error('변경할 내용이 없습니다. title, body 또는 fields를 입력하세요.');
      result = { item_id: itemId, changed };
      break;
    }

    case 'archive':
    case 'unarchive': {
      const itemId = requireInput(env.INPUT_ITEM_ID, 'item_id');
      assertSameProject(await getItem(github, itemId), project);
      const mutation = action === 'archive' ? 'archiveProjectV2Item' : 'unarchiveProjectV2Item';
      await github.graphql(
        `mutation($p: ID!, $i: ID!) { ${mutation}(input: { projectId: $p, itemId: $i }) { item { id } } }`,
        { p: project.id, i: itemId },
      );
      result = { item_id: itemId };
      break;
    }

    case 'delete': {
      const itemId = requireInput(env.INPUT_ITEM_ID, 'item_id');
      const item = await getItem(github, itemId);
      assertSameProject(item, project);
      await github.graphql(
        `mutation($p: ID!, $i: ID!) { deleteProjectV2Item(input: { projectId: $p, itemId: $i }) { deletedItemId } }`,
        { p: project.id, i: itemId },
      );
      result = { deleted_item_id: itemId, title: item.content?.title };
      break;
    }

    default:
      throw new Error(`알 수 없는 작업: ${action}`);
  }

  core.info(`RESULT_JSON=${JSON.stringify(result)}`);
  if (action !== 'list') summary.addCodeBlock(JSON.stringify(result, null, 2), 'json');
  await summary.write();
  core.setOutput('result', JSON.stringify(result));
};
