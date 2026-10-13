DROP TRIGGER event_validation_run_transition_guard;
--> statement-breakpoint
CREATE TRIGGER event_validation_run_transition_guard BEFORE UPDATE ON event_validation_run WHEN NOT coalesce((
  (OLD.state='queued' AND NEW.state='preparing' AND NEW.retained_bytes=OLD.retained_bytes AND NEW.released_at IS NULL
    AND json_remove(NEW.record,'$.revision','$.state') IS json_remove(OLD.record,'$.revision','$.state'))
  OR (OLD.state='preparing' AND NEW.state='preparing' AND NEW.retained_bytes=OLD.retained_bytes AND NEW.released_at IS NULL
    AND json_type(OLD.record,'$.snapshotHash')='null' AND json_type(NEW.record,'$.snapshotHash')='text'
    AND length(json_extract(NEW.record,'$.snapshotHash'))=64 AND json_extract(NEW.record,'$.snapshotHash') NOT GLOB '*[^0-9a-f]*'
    AND json_type(NEW.record,'$.processIncarnation')='text' AND json_type(NEW.record,'$.workspaceIdentity')='object'
    AND json_remove(NEW.record,'$.revision','$.snapshotHash','$.processIncarnation','$.workspaceIdentity') IS
        json_remove(OLD.record,'$.revision','$.snapshotHash','$.processIncarnation','$.workspaceIdentity'))
  OR (OLD.state='preparing' AND NEW.state='dispatching' AND NEW.cancel_requested=0 AND NEW.retained_bytes=OLD.retained_bytes AND NEW.released_at IS NULL
    AND NEW.started_at IS NOT NULL AND json_type(OLD.record,'$.snapshotHash')='text' AND json_type(OLD.record,'$.processIncarnation')='text'
    AND json_type(OLD.record,'$.workspaceIdentity')='object'
    AND json_remove(NEW.record,'$.revision','$.state','$.startedAt') IS json_remove(OLD.record,'$.revision','$.state','$.startedAt'))
  OR (OLD.state IN ('queued','preparing','dispatching') AND NEW.state=OLD.state AND OLD.cancel_requested=0 AND NEW.cancel_requested=1
    AND json_remove(NEW.record,'$.revision','$.cancelRequested') IS json_remove(OLD.record,'$.revision','$.cancelRequested'))
  OR (OLD.state='dispatching' AND NEW.state='dispatching' AND json_type(OLD.record,'$.processID')='null'
    AND json_type(NEW.record,'$.processID')='integer' AND json_extract(NEW.record,'$.processID')>0
    AND json_remove(NEW.record,'$.revision','$.processID') IS json_remove(OLD.record,'$.revision','$.processID'))
  OR (OLD.state IN ('queued','preparing') AND ((NEW.state='cancelled' AND NEW.cancel_requested=1 AND NEW.outcome='cancelled')
      OR (NEW.state='superseded' AND NEW.outcome='refused'))
    AND NEW.started_at IS NULL AND NEW.terminal_at IS NOT NULL AND NEW.retained_bytes=OLD.retained_bytes AND NEW.released_at IS NULL
    AND json_type(NEW.record,'$.result')='null' AND json_type(NEW.record,'$.resultCurrent')='false' AND json_type(NEW.record,'$.processID')='null'
    AND json_remove(NEW.record,'$.revision','$.state','$.outcome','$.terminalAt') IS json_remove(OLD.record,'$.revision','$.state','$.outcome','$.terminalAt'))
  OR (OLD.state='dispatching' AND NEW.state IN ('settled','superseded') AND NEW.outcome IS NOT NULL AND NEW.terminal_at IS NOT NULL
    AND NEW.retained_bytes=OLD.retained_bytes AND NEW.released_at IS NULL AND NEW.started_at IS OLD.started_at
    AND json_type(NEW.record,'$.result')='object' AND json_extract(NEW.record,'$.result.outcome') IS NEW.outcome
    AND json_type(NEW.record,'$.result.stopConfirmed')='true'
    AND json_type(NEW.record,'$.result.stdout.complete')='true' AND json_type(NEW.record,'$.result.stderr.complete')='true'
    AND ((NEW.state='settled' AND json_type(NEW.record,'$.resultCurrent')='true') OR (NEW.state='superseded' AND json_type(NEW.record,'$.resultCurrent')='false'))
    AND json_remove(NEW.record,'$.revision','$.state','$.outcome','$.terminalAt','$.result','$.resultCurrent') IS
        json_remove(OLD.record,'$.revision','$.state','$.outcome','$.terminalAt','$.result','$.resultCurrent'))
  OR (OLD.state='dispatching' AND NEW.state='unknown' AND NEW.outcome IS NULL AND NEW.terminal_at IS NOT NULL
    AND NEW.retained_bytes=OLD.retained_bytes AND NEW.released_at IS NULL
    AND json_type(NEW.record,'$.result')='null' AND json_type(NEW.record,'$.resultCurrent')='false'
    AND json_remove(NEW.record,'$.revision','$.state','$.terminalAt') IS json_remove(OLD.record,'$.revision','$.state','$.terminalAt'))
  OR (OLD.state IN ('settled','cancelled','superseded') AND NEW.state=OLD.state AND OLD.released_at IS NULL AND NEW.released_at IS NOT NULL
    AND NEW.retained_bytes=0 AND json_type(OLD.record,'$.snapshotHash')='text' AND json_type(OLD.record,'$.workspaceIdentity')='object'
    AND json_remove(NEW.record,'$.revision','$.retainedBytes','$.releasedAt') IS json_remove(OLD.record,'$.revision','$.retainedBytes','$.releasedAt'))
  OR (OLD.state IN ('cancelled','superseded') AND NEW.state=OLD.state AND OLD.outcome IN ('cancelled','refused')
    AND OLD.started_at IS NULL AND json_type(OLD.record,'$.processID')='null' AND json_type(OLD.record,'$.result')='null'
    AND OLD.released_at IS NULL AND NEW.released_at IS NOT NULL AND NEW.retained_bytes=0
    AND json_type(OLD.record,'$.preparationRelease') IS NULL AND json_type(NEW.record,'$.preparationRelease')='object'
    AND json_type(NEW.record,'$.preparationRelease.version')='integer' AND json_extract(NEW.record,'$.preparationRelease.version')=1
    AND json_type(NEW.record,'$.preparationRelease.preparationID')='text'
    AND length(CAST(json_extract(NEW.record,'$.preparationRelease.preparationID') AS BLOB)) BETWEEN 1 AND 512
    AND instr(json_extract(NEW.record,'$.preparationRelease.preparationID'),char(0))=0
    AND json_type(NEW.record,'$.preparationRelease.observedAt')='integer'
    AND json_extract(NEW.record,'$.preparationRelease.observedAt') BETWEEN OLD.created_at AND NEW.released_at
    AND ((json_extract(NEW.record,'$.preparationRelease.kind')='no_workspace_created'
      AND json_type(NEW.record,'$.preparationRelease.workspaceIdentity')='null'
      AND json_type(OLD.record,'$.workspaceIdentity')='null' AND json_type(OLD.record,'$.snapshotHash')='null')
      OR (json_extract(NEW.record,'$.preparationRelease.kind')='partial_workspace_cleaned'
      AND json_type(NEW.record,'$.preparationRelease.workspaceIdentity')='object'
      AND json_extract(NEW.record,'$.preparationRelease.workspaceIdentity.kind')='posix'
      AND json_type(NEW.record,'$.preparationRelease.workspaceIdentity.device')='text'
      AND length(json_extract(NEW.record,'$.preparationRelease.workspaceIdentity.device')) BETWEEN 1 AND 32
      AND json_extract(NEW.record,'$.preparationRelease.workspaceIdentity.device') NOT GLOB '*[^0-9]*'
      AND json_type(NEW.record,'$.preparationRelease.workspaceIdentity.inode')='text'
      AND length(json_extract(NEW.record,'$.preparationRelease.workspaceIdentity.inode')) BETWEEN 1 AND 32
      AND json_extract(NEW.record,'$.preparationRelease.workspaceIdentity.inode') NOT GLOB '*[^0-9]*'
      AND (json_type(OLD.record,'$.workspaceIdentity')='null' OR
        json_extract(NEW.record,'$.preparationRelease.workspaceIdentity') IS json_extract(OLD.record,'$.workspaceIdentity'))))
    AND json_remove(NEW.record,'$.revision','$.retainedBytes','$.releasedAt','$.preparationRelease') IS
        json_remove(OLD.record,'$.revision','$.retainedBytes','$.releasedAt','$.preparationRelease'))

),0) BEGIN SELECT RAISE(ABORT,'validation_run_transition'); END;
