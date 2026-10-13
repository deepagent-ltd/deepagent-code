import assert from "node:assert/strict"
import { Effect, Layer, Schema } from "effect"
import { NodeHttpServer } from "@effect/platform-node"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { Database } from "@deepagent-code/core/database/database"
import { EventValidationSchema } from "@deepagent-code/core/deepagent/event-validation.schema"
import { EventValidationHost } from "../../../src/deepagent/event-validation"
import { EventInvestigationHost } from "../../../src/deepagent/event-investigation"
import { EventValidationHttpApi } from "../../../src/server/routes/instance/httpapi/api"
import { eventValidationHandlers } from "../../../src/server/routes/instance/httpapi/handlers/event-validation"
import { eventInvestigationHandlers } from "../../../src/server/routes/instance/httpapi/handlers/event-investigation"
import { authorizationLayer } from "../../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../../src/server/routes/instance/httpapi/middleware/schema-error"
import { HttpApiApp } from "../../../src/server/routes/instance/httpapi/server"
import { ServerAuth } from "../../../src/server/auth"

/** Actual Node TCP transport + production handler/auth/native service; the surrounding
 * fixture creates a real Session and explicit operator policy, with no model invocation. */
export const runHTTP = Effect.fn(function* (input: { sessionID: string; configuration: EventValidationSchema.Configuration; password: string }) {
  const actual = yield* Effect.context<Database.Service | EventValidationHost.Service | ServerAuth.Config>()
  const routes = HttpRouter.serve(HttpApiBuilder.layer(EventValidationHttpApi).pipe(
    Layer.provide([eventValidationHandlers(), eventInvestigationHandlers()]),
    Layer.provide(EventInvestigationHost.layer.pipe(Layer.provide(Layer.succeedContext(actual)))),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    HttpRouter.provideRequest(Layer.succeedContext(HttpApiApp.context)),
    Layer.provide(Layer.succeedContext(actual)),
  ), { disableLogger: true, disableListenLog: true }).pipe(Layer.provideMerge(NodeHttpServer.layerTest))
  return yield* Effect.gen(function* () {
    const db=(yield* Database.Service).db
    const call=(route:string, body:unknown, authenticated=true) => HttpClientRequest.post(`/api/v1/event-validation/${route}`).pipe(
      HttpClientRequest.setBody(HttpBody.jsonUnsafe(body)),
      HttpClientRequest.setHeaders(authenticated ? { authorization:`Basic ${Buffer.from(`ev-operator:${input.password}`).toString("base64")}` } : {}),
      HttpClient.execute)
    const denied=yield* call("candidates",{sessionID:input.sessionID},false)
    assert.equal(denied.status,401)
    const response=yield* call("candidates",{sessionID:input.sessionID})
    assert.equal(response.status,200)
    const candidates=yield* Schema.decodeUnknownEffect(EventValidationSchema.Candidates)(yield* response.json)
    assert.equal(candidates.targets[0]?.recipes[0]?.logicalID,input.configuration.recipe.logicalID)
    const preview=yield* call("capture",{sessionID:input.sessionID,targetID:"project",recipeID:input.configuration.recipe.logicalID,
      parameters:[],watch:input.configuration.watch,maxRuns:1,expiresAt:input.configuration.expiresAt})
    assert.equal(preview.status,200)
    const captured=yield* Schema.decodeUnknownEffect(EventValidationSchema.Captured)(yield* preview.json)
    const command={captureID:captured.captureID,ruleID:"http-rule",requestID:"http-configure",expectedRevision:0}
    const configured=yield* call("rules/configure-captured",command)
    assert.equal(configured.status,200)
    const first=yield* configured.json
    const exact=yield* call("rules/configure-captured",command)
    assert.equal(exact.status,200)
    assert.deepEqual(yield* exact.json,{...Schema.decodeUnknownSync(Schema.Struct({receipt:EventValidationSchema.CommandReceipt,replayed:Schema.Boolean}))(first),replayed:true})
    const changed=yield* call("rules/configure-captured",{...command,captureID:"another-preview"})
    assert.equal(changed.status,409)
    const expired=yield* call("rules/configure-captured",{...command,requestID:"lost-preview",captureID:"lost"})
    assert.equal(expired.status,409)
    assert.equal((yield* Schema.decodeUnknownEffect(Schema.Struct({code:Schema.String}))(yield* expired.json)).code,"VALIDATION_CAPTURE_EXPIRED")
    const enabled=yield* call("rules/http-rule/control",{requestID:"http-enable",expectedRevision:1,action:"enable"})
    assert.equal(enabled.status,200)
    const deadline=Date.now()+45000
    while(Date.now()<deadline) {
      const rows=yield* db.get<{state:string;released_at:number|null}>("SELECT state,released_at FROM event_validation_run WHERE rule_id='http-rule'")
      if(rows?.state==="settled" && rows.released_at!==null) break
      yield* Effect.sleep(50)
    }
    const rows=yield* db.get<{count:number;released:number}>("SELECT count(*) count,sum(released_at IS NOT NULL) released FROM event_validation_run WHERE rule_id='http-rule'")
    assert.deepEqual(rows,{count:1,released:1})
    const before=yield* db.get("SELECT revision,record FROM event_validation_rule WHERE rule_id='http-rule'")
    const exhausted=yield* call("rules/http-rule/control",{requestID:"http-exhausted",expectedRevision:2,action:"verify"})
    assert.equal(exhausted.status,429)
    assert.deepEqual(yield* exhausted.json,{status:429,code:"VALIDATION_CAPACITY",
      message:"Project validation is unavailable, changed, or needs reconciliation"})
    assert.deepEqual(yield* db.get("SELECT revision,record FROM event_validation_rule WHERE rule_id='http-rule'"),before)
    assert.deepEqual(yield* db.get("SELECT count(*) count FROM event_validation_command WHERE request_id='http-exhausted'"),{count:0})
    assert.deepEqual(yield* db.get("SELECT count(*) count,sum(released_at IS NOT NULL) released FROM event_validation_run WHERE rule_id='http-rule'"),rows)
    const counts=yield* db.get<{inputs:number;providers:number}>("SELECT (SELECT count(*) FROM session_input) inputs,(SELECT count(*) FROM session_v2_provider_turn_receipt) providers")
    assert.deepEqual(counts,{inputs:0,providers:0})
    return {denied:denied.status,candidates:response.status,capture:preview.status,configure:configured.status,exact:exact.status,
      conflict:changed.status,expired:expired.status,exhausted:exhausted.status,counts,runs:rows}
  }).pipe(Effect.provide(routes),Effect.provide(actual))
})
