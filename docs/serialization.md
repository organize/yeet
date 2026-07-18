[← README](../README.md) · [Documentation](./README.md)

# Serialization And Schemas

`Left` and `Right` serialize to small tagged JSON objects. Nothing clever is
hiding under the floorboards.

```ts
JSON.stringify(left('Nope'))
// {"_tag":"Left","error":"Nope"}
// inferred: string

JSON.stringify(right({ id: 'user-1' }))
// {"_tag":"Right","value":{"id":"user-1"}}
// inferred: string
```

`toJSON()` eagerly converts nested values that provide their own `toJSON`.
Native `Error` objects become plain `{ name, message, ...fields }` objects. This
keeps the returned transport object boring even in frameworks that inspect
prototypes before JSON encoding, as some server-function and RPC layers do.

```ts
class NotFound extends Error {
  readonly _tag = 'NotFound'

  toJSON() {
    return { _tag: this._tag, message: this.message }
  }
}

left(new NotFound('User not found')).toJSON()
// { _tag: 'Left', error: { _tag: 'NotFound', message: 'User not found' } }
// inferred: SerializedLeft<{ _tag: "NotFound"; message: string }>
```

## Hydrating Trusted JSON

For trusted values that already have the serialized shape, `fromJSON` hydrates
them back into `Left` / `Right` instances:

```ts
import {
  fromJSON,
  isSerializedEither,
  type SerializedEither,
} from '@big-time/yeet'

type User = { id: string }

const parsed = JSON.parse(json) as SerializedEither<string, User>
// inferred: SerializedEither<string, User>

if (isSerializedEither(parsed)) {
  const result = fromJSON(parsed)
  // inferred: Either<string, User>
}
```

`isSerializedEither(value)` detects yeet's strict outer envelope. It does not
validate nested payloads; that is what schemas are for.

## Validating Untrusted JSON

When the JSON came from outside the room, use a schema. `yeet` accepts Standard
Schema-compatible validators for the `error` and `value` payloads, so you can
bring Zod, Valibot, ArkType, TypeBox adapters, or whatever your project already
uses. `yeet` does not import any of them. It merely checks for `~standard` and
lets the grown-ups speak for themselves.

With Zod, pass schemas directly when you want validation or hydration:

```ts
import * as z from 'zod'
import { eitherSchema, serializedEitherSchema } from '@big-time/yeet'

const ApiError = z.object({
  code: z.string(),
  message: z.string(),
})

const User = z.object({
  id: z.string(),
  email: z.email(),
})

type ApiError = z.infer<typeof ApiError>
type User = z.infer<typeof User>

const SerializedUserResult = serializedEitherSchema({
  error: ApiError,
  value: User,
})
// inferred: SerializedEitherSchema<ApiError, User>

const HydratedUserResult = eitherSchema({
  error: ApiError,
  value: User,
})
// inferred: EitherSchema<ApiError, User>

const parsed = await SerializedUserResult['~standard'].validate(
  JSON.parse(json),
)
// inferred: Standard Schema result containing SerializedEither<ApiError, User>

const hydrated = await HydratedUserResult['~standard'].validate(
  JSON.parse(json),
)
// inferred: Standard Schema result containing Either<ApiError, User>
```

`serializedEitherSchema` returns the plain transport shape:

```ts
// { value: { _tag: 'Left', error: { code, message } } }
// { value: { _tag: 'Right', value: { id, email } } }
```

`eitherSchema` validates the same JSON, then hydrates the output into real
`Left` / `Right` instances:

```ts
if (hydrated.issues === undefined) {
  // hydrated.value is Left<ApiError> | Right<User>
}
```

Nested schemas are optional. Without them, `yeet` validates the outer
`{ _tag, error | value }` envelope and leaves the payload as `unknown`.

Scoped async work has a small extra vocabulary: domain errors, `Aborted`,
`Rejected`, and `Suppressed`. Use `exitErrorSchema`, `serializedExitSchema`, and
`exitSchema` when you want that whole outcome to be a portable value.

```ts
import { exitSchema, serializedExitSchema } from '@big-time/yeet'

const SerializedUserExit = serializedExitSchema({
  error: ApiError,
  value: User,
})
// inferred: SerializedExitSchema<ApiError, User>

const HydratedUserExit = exitSchema({
  error: ApiError,
  value: User,
})
// inferred: ExitSchema<ApiError, User>
// validates Left<ApiError | Aborted | Rejected | Suppressed> | Right<User>
```

If no domain `error` schema is provided, the Exit schemas accept only yeet's
built-in `Aborted`, `Rejected`, and `Suppressed` error payloads. Add `reason` or
`cause` schemas when those payloads need tighter validation too.

## Exporting JSON Schema

Standard Schema and Standard JSON Schema are separate interfaces. If a nested
schema only implements validation, validation still works; its JSON Schema slot
is emitted as `{}` because `yeet` refuses to invent facts in a nice hat.

For JSON Schema export with Zod, be explicit. Zod's documented API is
`z.toJSONSchema(schema)`, with `{ io: 'input' }` when you need the input side of
a transforming schema. Recent Zod versions may expose Standard JSON Schema
directly, but a tiny adapter keeps the README honest and lets you use Zod's
conversion options.

```ts
import * as z from 'zod'
import { serializedEitherSchema } from '@big-time/yeet'

type JsonSchema = Record<string, unknown>
type JsonSchemaOptions = {
  readonly target: 'draft-2020-12' | 'draft-07' | 'openapi-3.0'
}

const withZodJsonSchema = <Schema extends z.ZodType>(
  schema: Schema,
): typeof schema & {
  readonly '~standard': (typeof schema)['~standard'] & {
    readonly jsonSchema: {
      readonly input: (options: JsonSchemaOptions) => JsonSchema
      readonly output: (options: JsonSchemaOptions) => JsonSchema
    }
  }
} => ({
  ...schema,
  '~standard': {
    ...schema['~standard'],
    jsonSchema: {
      input: (options: JsonSchemaOptions) =>
        z.toJSONSchema(schema, { target: options.target, io: 'input' }),
      output: (options: JsonSchemaOptions) =>
        z.toJSONSchema(schema, { target: options.target }),
    },
  },
})

const SerializedUserResult = serializedEitherSchema({
  error: withZodJsonSchema(ApiError),
  value: withZodJsonSchema(User),
})
// inferred: SerializedEitherSchema<ApiError, User>

const jsonSchema = SerializedUserResult['~standard'].jsonSchema.output({
  target: 'draft-2020-12',
})
// inferred: JsonSchema
```

TypeBox and TypeMap fit the same hole. Compile or adapt TypeBox schemas into
validators that expose `~standard`, then pass them in:

```ts
import { Type } from '@sinclair/typebox'
import { Compile } from '@sinclair/typemap'
import { serializedEitherSchema } from '@big-time/yeet'

const ApiError = Compile(
  Type.Object({
    code: Type.String(),
    message: Type.String(),
  }),
)

const User = Compile(
  Type.Object({
    id: Type.String(),
    email: Type.String({ format: 'email' }),
  }),
)

const SerializedUserResult = serializedEitherSchema({
  error: ApiError,
  value: User,
})
// inferred: SerializedEitherSchema<ApiError, User>
```

When the nested schemas implement Standard JSON Schema, `yeet` includes their
JSON Schema inside the exported `Either` envelope. That gives you a portable
shape for API docs, structured outputs, form builders, or any other bit of
software that enjoys receiving small rectangles of truth.

---

[← Documentation](./README.md)
