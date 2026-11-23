import type { EndpointStatus } from "@repo/shared/webhook-endpoint";
import { deleteEndpointAction, setEndpointStatusAction } from "../(app)/endpoints/actions";

// enable or disable, and delete behind a confirmation. a details element needs no script, the
// confirm button only appears once it is opened
export function EndpointActions({ id, status }: { id: string; status: EndpointStatus }) {
  const next = status === "active" ? "disabled" : "active";
  return (
    <div className="row">
      <form action={setEndpointStatusAction}>
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="status" value={next} />
        <button type="submit" className="secondary">
          {status === "active" ? "disable" : "enable"}
        </button>
      </form>
      <details>
        <summary>delete</summary>
        <form action={deleteEndpointAction}>
          <p>delete this endpoint? its deliveries stop, and this cannot be undone.</p>
          <input type="hidden" name="id" value={id} />
          <button type="submit" className="danger">
            confirm delete
          </button>
        </form>
      </details>
    </div>
  );
}
