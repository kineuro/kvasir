// SPDX-License-Identifier: AGPL-3.0-only
// The admission suite's fixtures (Wave 4c section 8.6): our own tool
// schemas, vendored from the engine's MCP door (tools/list, contract mcp
// v1), and twenty prompts each of which a well-formed call answers. Data
// only; the suite reads them, a person edits them.

export interface ToolFixture {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const TOOLS: ToolFixture[] = [
  {
    name: "nils_guide",
    description:
      "Read this before writing a document: the rules a document obeys, two worked question-and-document pairs, the schema digest, the doors and the caps in force. One call, once per conversation.\n- Call it first, and again only when the schema digest in the catalog changed.",
    parameters: {
      type: "object",
      properties: {},
      description:
        "Read this first: the grounding rules, the worked examples, the schema digest, the doors and the caps in force",
    },
  },
  {
    name: "nils_catalog",
    description:
      "What this registry holds and what a question may name: the grains and how they meet, every level's fields with their type and class, the classification axes with their values, the event kinds, the diseases, the cohorts, the session schemes, the comparability levels, the derived fields, the window presets and the function table. Read this before writing a document; page a level with after.\n- Ask for one level when you know it, and page with after rather than asking for everything.",
    parameters: {
      type: "object",
      properties: {
        level: {
          type: "string",
          description:
            "One level (subject, session, study, series, stack, instance, event, cohort); every level when absent",
        },
        after: {
          type: "string",
          description: "The path the previous page ended on",
        },
      },
    },
  },
  {
    name: "nils_validate",
    description:
      "Validate a document strictly and return its content hash, the selections it pins and the warnings that did not refuse it. Under mode repair the structural slips are fixed first (a missing options object, a lone clause, an operator alias) and the repairs are reported.\n- Validate every document before running it, and read the issues rather than guessing at a fix.",
    parameters: {
      type: "object",
      properties: {
        document: {
          type: "object",
          description: "The ask as JSON, as the schema of GET /api/ask/schema describes it",
        },
        document_id: {
          type: "integer",
          description: "A document handle from a previous call, instead of the document itself",
        },
        mode: {
          type: "string",
          enum: ["strict", "repair"],
          description: "repair fixes what is structural first and reports it",
        },
      },
    },
  },
  {
    name: "nils_describe",
    description:
      "One sentence per set in the order the engine reads them, the conventions that always apply, the denominators by name, how each attached row was chosen, and the disclosure level. Use it to show a person what the document actually asks before it runs.",
    parameters: {
      type: "object",
      properties: {
        document: {
          type: "object",
          description: "The ask as JSON, as the schema of GET /api/ask/schema describes it",
        },
        document_id: {
          type: "integer",
          description: "A document handle from a previous call, instead of the document itself",
        },
      },
    },
  },
  {
    name: "nils_options",
    description:
      "What one set of a document may become: its resolved shape, its sentence, and the typed moves with stable ids, each a template with holes and the legal fillers. Apply a move by its id with nils_apply, against the token this call returns.\n- A move id is stable only inside one options answer; call options again after every apply.",
    parameters: {
      type: "object",
      properties: {
        document: {
          type: "object",
          description: "The ask as JSON, as the schema of GET /api/ask/schema describes it",
        },
        document_id: {
          type: "integer",
          description: "A document handle from a previous call, instead of the document itself",
        },
        set: {
          type: "string",
          description: "The set to offer moves on; the answer's set when absent",
        },
      },
    },
  },
  {
    name: "nils_apply",
    description:
      "Apply moves by id to a stored document, atomically, and return a new document handle with what changed and fresh options. It returns a handle, never a document; fetch the document by handle when you need to read it.",
    parameters: {
      type: "object",
      required: ["document_id", "epoch", "token", "set", "moves"],
      properties: {
        document_id: {
          type: "integer",
          description: "A document handle from a previous call, instead of the document itself",
        },
        epoch: {
          type: "integer",
        },
        token: {
          type: "string",
          description: "The token the options answer carried",
        },
        set: {
          type: "string",
        },
        moves: {
          type: "array",
          items: {
            type: "object",
            required: ["move_id"],
            properties: {
              move_id: {
                type: "integer",
              },
              args: {
                type: "object",
                description: "One value per hole of the move's template",
              },
            },
          },
        },
      },
    },
  },
  {
    name: "nils_diagnose",
    description:
      "Why a document answers as it does: the funnel set by set and stage by stage, what each clause of the answer dropped, the ties, the rows coarser than a day, the unresolved uploads, the cost class, and a one line explanation when nothing comes back.\n- When an answer is empty or smaller than expected, diagnose before changing the document.",
    parameters: {
      type: "object",
      properties: {
        document: {
          type: "object",
          description: "The ask as JSON, as the schema of GET /api/ask/schema describes it",
        },
        document_id: {
          type: "integer",
          description: "A document handle from a previous call, instead of the document itself",
        },
        keys: {
          type: "boolean",
          description: "Carry the surviving subject keys through the funnel",
        },
      },
    },
  },
  {
    name: "nils_preview",
    description:
      "Ten rows of the answer, or the count, by the document's level. Cheap enough to check a document reads as intended before running it.",
    parameters: {
      type: "object",
      properties: {
        document: {
          type: "object",
          description: "The ask as JSON, as the schema of GET /api/ask/schema describes it",
        },
        document_id: {
          type: "integer",
          description: "A document handle from a previous call, instead of the document itself",
        },
        rows: {
          type: "integer",
          description: "Rows to show, inside the preview cap",
        },
      },
    },
  },
  {
    name: "nils_draft",
    description:
      "A whole document as text when no move reaches what you need: the structural repairs are applied and reported, the diagnosis says what is wrong in domain words, and a valid document is stored and answered by handle. Prefer options and apply; draft is the fallback.\n- Never write SQL here or anywhere; a draft is the document, in YAML or JSON.",
    parameters: {
      type: "object",
      required: ["text"],
      properties: {
        text: {
          type: "string",
          description:
            "A whole document as YAML or JSON; structural repairs are applied and reported, and a valid document is stored",
        },
      },
    },
  },
  {
    name: "nils_run",
    description:
      "Run a document inside the caps and leave a handle: its columns, its first page of rows, its content hash, and whether a cap truncated it. Name the handle to keep its rows and its question together.\n- Cite the handle in what you write; paste rows only when a person asked to see them.",
    parameters: {
      type: "object",
      properties: {
        document: {
          type: "object",
          description: "The ask as JSON, as the schema of GET /api/ask/schema describes it",
        },
        document_id: {
          type: "integer",
          description: "A document handle from a previous call, instead of the document itself",
        },
        name: {
          type: "string",
          description: "A name for the handle; a named handle keeps its question with its rows",
        },
        keep: {
          type: "boolean",
          description: "Leave a handle for every kept set too",
        },
      },
    },
  },
  {
    name: "nils_job",
    description:
      "Run a document as a job under your own roles when a run came back truncated: the answer is a job id, and the result (the handle, the hash, the counts) is read with nils_job_status once the job is done.\n- A job runs under the roles you hold; it reaches nothing a run refused you.",
    parameters: {
      type: "object",
      properties: {
        document: {
          type: "object",
          description: "The ask as JSON, as the schema of GET /api/ask/schema describes it",
        },
        document_id: {
          type: "integer",
          description: "A document handle from a previous call, instead of the document itself",
        },
        name: {
          type: "string",
        },
        keep: {
          type: "boolean",
        },
      },
      description:
        "Run a document as a job under your own roles when the synchronous run was truncated; poll it with job_status",
    },
  },
  {
    name: "nils_job_status",
    description:
      "The state of a job and, once it is done, its result: the handle to page with nils_rows, the hash, the row count and whether a cap cut it.\n- Poll rather than spin, since a job that is queued or running answers its state only.",
    parameters: {
      type: "object",
      required: ["job"],
      properties: {
        job: {
          type: "integer",
          description: "The id the job answer carried",
        },
      },
      description: "The job's state and, once done, its result: the handle, the hash and the counts",
    },
  },
  {
    name: "nils_rows",
    description:
      "One page of a handle's rows, by page number. Pages are bounded; read the next page rather than asking for everything at once.",
    parameters: {
      type: "object",
      required: ["handle"],
      properties: {
        handle: {
          type: "integer",
        },
        page: {
          type: "integer",
          description: "The handle's page to read, from zero",
        },
        offset: {
          type: "integer",
          description: "Where in that page to start; an answer says next_offset while rows remain",
        },
      },
    },
  },
];

export interface CallFixture {
  /** What the caller says. */
  prompt: string;
  /** The tool a well-formed answer calls. */
  tool: string;
  /** Arguments the call must carry, with their values where the prompt fixes them. */
  args: Record<string, unknown>;
}

/** Twenty prompts, one call each, over the schemas above. */
export const FIXTURES: CallFixture[] = [
  { prompt: "Read the guide before anything else.", tool: "nils_guide", args: {} },
  { prompt: "Show me the catalog at the session level.", tool: "nils_catalog", args: { level: "session" } },
  { prompt: "List the catalog at the stack level.", tool: "nils_catalog", args: { level: "stack" } },
  {
    prompt: "What does the catalog hold at the cohort level?",
    tool: "nils_catalog",
    args: { level: "cohort" },
  },
  {
    prompt: "Validate document 12 strictly.",
    tool: "nils_validate",
    args: { document_id: 12, mode: "strict" },
  },
  { prompt: "Describe document 7 set by set.", tool: "nils_describe", args: { document_id: 7 } },
  {
    prompt: "What moves are open on the set named scope of document 7?",
    tool: "nils_options",
    args: { document_id: 7, set: "scope" },
  },
  {
    prompt: "Which moves may the set visits of document 3 take?",
    tool: "nils_options",
    args: { document_id: 3, set: "visits" },
  },
  {
    prompt: "Apply move 4 with no arguments to the set scope of document 7, epoch 2, token abc123.",
    tool: "nils_apply",
    args: { document_id: 7, epoch: 2, token: "abc123", set: "scope", moves: [{ move_id: 4 }] },
  },
  {
    prompt: "Diagnose document 9 and include the keys.",
    tool: "nils_diagnose",
    args: { document_id: 9, keys: true },
  },
  {
    prompt: "Why does document 5 answer as it does? Diagnose it.",
    tool: "nils_diagnose",
    args: { document_id: 5 },
  },
  { prompt: "Preview ten rows of document 9.", tool: "nils_preview", args: { document_id: 9, rows: 10 } },
  { prompt: "Preview document 2, three rows only.", tool: "nils_preview", args: { document_id: 2, rows: 3 } },
  {
    prompt: "Draft a document from this text: sets: {scope: {grain: cohort}}",
    tool: "nils_draft",
    args: { text: "sets: {scope: {grain: cohort}}" },
  },
  {
    prompt: "Run document 9 and name the handle september.",
    tool: "nils_run",
    args: { document_id: 9, name: "september" },
  },
  { prompt: "Run document 4 and keep the handle.", tool: "nils_run", args: { document_id: 4, keep: true } },
  {
    prompt: "The run of document 9 came back truncated; run it as a job named nightly.",
    tool: "nils_job",
    args: { document_id: 9, name: "nightly" },
  },
  { prompt: "What is the state of job 31?", tool: "nils_job_status", args: { job: 31 } },
  { prompt: "Read page 2 of handle 77.", tool: "nils_rows", args: { handle: 77, page: 2 } },
  { prompt: "Read the first page of handle 80.", tool: "nils_rows", args: { handle: 80, page: 0 } },
];
