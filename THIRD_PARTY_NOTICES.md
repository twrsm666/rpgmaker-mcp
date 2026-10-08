# Third-party components and external resources

Direct dependencies declared in `package.json`:

| Package | Version | Declared license |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` | 1.32.1 | MIT |
| `playwright-core` | 1.63.0 | Apache-2.0 |
| `zod` | 4.6.5 | MIT |

They are installed with npm; their source and transitive dependencies are not
included in this source archive. Their respective license files accompany the
installed packages. `package-lock.json` records the dependency tree and
integrity values.

RPG Maker MZ core scripts, graphics, characters, sound, fonts, data templates,
NW.js and other files from a user's engine installation are **not included**
in this repository. They remain subject to their own licenses. Users must
supply a locally licensed installation or appropriate project assets.

The design renderer reads local MZ Tilemap definitions at runtime. The native
launcher may create a private local copy of an installed NW.js runtime; this
generated folder is excluded from source distribution. Do not upload that
folder or generated demo assets to an open-source repository.

The MIT license at repository root applies only to original code and
documentation in this repository. It does not grant rights to external
RPG Maker resources, third-party software, or third-party project plugins.
