irichard@irichard-Super-PC:~$ docker ps
CONTAINER ID   IMAGE                                COMMAND                    CREATED          STATUS                          PORTS                                                                                    NAMES
b624079ddcbc   browserx-applepi-server              "docker-entrypoint.s…"     21 minutes ago   Restarting (1) 21 seconds ago                                                                                            browserx-applepi-server-1
3d208b360bf1   ai-assistant-web                     "sh -c '\n  if [ \"$HT…"   2 weeks ago      Up 4 days                       0.0.0.0:8000->8000/tcp, [::]:8000->8000/tcp, 0.0.0.0:443->8000/tcp, [::]:443->8000/tcp   ai-helper-dev
ccea6c377804   ai_republic_customer_admin-web       "bash start.sh"            5 weeks ago      Up 4 days                       0.0.0.0:5678->5678/tcp, [::]:5678->5678/tcp, 0.0.0.0:88->8000/tcp, [::]:88->8000/tcp     enterprise-management-test
4e358683ebe0   data_reader-scheduler                "./data_reader/run_s…"     7 months ago     Up 4 days (healthy)                                                                                                      enterprise_rag_scheduler
a64745110747   ghcr.io/open-webui/open-webui:main   "bash start.sh"            12 months ago    Up 4 days (healthy)             0.0.0.0:3000->8080/tcp, [::]:3000->8080/tcp                                              open-webui
dd83fccf7f2b   9286fd29cdad                         "bash start.sh"            13 months ago    Up 4 days (healthy)             0.0.0.0:3001->8080/tcp, [::]:3001->8080/tcp                                              open-webui-openai
irichard@irichard-Super-PC:~$ docker logs -f b624079ddcbc
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
file:///app/dist/server/index.mjs:14
import { RRule } from "rrule";
         ^^^^^
SyntaxError: Named export 'RRule' not found. The requested module 'rrule' is a CommonJS module, which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:

import pkg from 'rrule';
const { RRule } = pkg;

    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:335:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.1
