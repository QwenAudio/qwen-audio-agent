"""JSON-lines bridge to local tau2 tools and opt-in user simulation/evaluation."""

import copy
import importlib
import json
import os
import sys
import subprocess
from pathlib import Path

root = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(root / "src"))
# tau2 imports/logging must not corrupt the JSON-lines protocol.
protocol = sys.stdout
sys.stdout = sys.stderr
sessions = {}
tasks = {}
trajectories = {}
users = {}
agents = {}


def dispatch(request):
    """Load isolated official environments and execute their original tools."""
    method = request["method"]
    session_id = request["sessionId"]
    if method == "load":
        domain = request["domain"]
        if domain not in ("retail", "airline"):
            raise ValueError("Unsupported tau domain")
        module = importlib.import_module(f"tau2.domains.{domain}.environment")
        db_type = module.RetailDB if domain == "retail" else module.FlightDB
        database = request.get("database")
        env = module.get_environment(
            db=None if database is None else db_type.model_validate(database)
        )
        task = None
        if request.get("taskId") is not None:
            task = next(
                (t for t in module.get_tasks(None) if t.id == request["taskId"]), None
            )
            if task is None:
                raise ValueError("Unknown task ID")
            initial = task.initial_state
            if initial is not None:
                env.set_state(
                    initial.initialization_data,
                    initial.initialization_actions,
                    initial.message_history or [],
                )
        if request.get("policy") is not None:
            env.policy = request["policy"]
        definitions = []
        for tool in env.get_tools():
            schema = tool.openai_schema["function"]
            definitions.append({
                "name": schema["name"],
                "description": schema["description"],
                "inputSchema": schema["parameters"],
                "annotations": {"readOnlyHint": not env.tools.tool_mutates_state(tool.name)},
            })
        commit = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "HEAD"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        dirty = bool(subprocess.run(
            ["git", "-C", str(root), "status", "--porcelain"],
            capture_output=True, text=True, check=True,
        ).stdout.strip())
        sessions[session_id] = env
        tasks[session_id] = task
        trajectories[session_id] = list(task.initial_state.message_history or []) if task and task.initial_state else []
        return {
            "domain": domain, "policy": env.get_policy(), "definitions": definitions,
            "task": None if task is None else task.model_dump(mode="json"),
            "sourceCommit": commit, "sourceDirty": dirty,
        }
    if method == "delete":
        sessions.pop(session_id, None)
        tasks.pop(session_id, None)
        trajectories.pop(session_id, None)
        users.pop(session_id, None)
        agents.pop(session_id, None)
        return {"ok": True}
    env = sessions[session_id]
    if method == "agent-init":
        from tau2.agent.llm_agent import LLMAgent

        agent = LLMAgent(
            tools=env.get_tools(), domain_policy=env.get_policy(),
            llm=f"openai/{request['model']}",
            llm_args={"api_key": os.environ["DASHSCOPE_API_KEY"],
                      "api_base": request["baseURL"], "timeout": 90,
                      "num_retries": 0,
                      "extra_body": {"enable_thinking": True}},
        )
        agents[session_id] = (agent, agent.get_init_state(), None)
        return {"ok": True}
    if method == "agent-step":
        from tau2.data_model.message import UserMessage, MultiToolMessage

        agent, state, pending = agents[session_id]
        message = UserMessage(role="user", content=request["content"]) if "content" in request else pending
        if message is None:
            raise ValueError("No pending tool response")
        reply, state = agent.generate_next_message(message, state)
        responses = []
        if reply.tool_calls:
            trajectories[session_id].append(reply)
            for call in reply.tool_calls:
                response = env.get_response(call)
                trajectories[session_id].append(response)
                responses.append(response)
        pending = MultiToolMessage(role="tool", tool_messages=responses) if responses else None
        agents[session_id] = (agent, state, pending)
        return {"content": reply.content or "", "toolCalls": len(responses)}
    if method == "user-init":
        from tau2.user.user_simulator import UserSimulator
        from tau2.user.user_simulator_base import is_valid_user_history_message

        task = tasks[session_id]
        if task is None:
            raise ValueError("A task is required for user simulation")
        model = request["model"]
        simulator = UserSimulator(
            llm=f"openai/{model}", instructions=str(task.user_scenario),
            llm_args={"api_key": os.environ["DASHSCOPE_API_KEY"],
                      "api_base": request["baseURL"], "temperature": 0.7,
                      "timeout": 90, "num_retries": 0,
                      "extra_body": {"enable_thinking": False}},
        )
        history = [m for m in trajectories[session_id] if is_valid_user_history_message(m)]
        users[session_id] = (simulator, simulator.get_init_state(history))
        return {"ok": True}
    if method == "user-turn":
        from tau2.data_model.message import AssistantMessage

        simulator, state = users[session_id]
        message = AssistantMessage(role="assistant", content=request["content"])
        if message.content:
            trajectories[session_id].append(message)
        reply, state = simulator.generate_next_message(message, state)
        users[session_id] = (simulator, state)
        trajectories[session_id].append(reply)
        return {"content": reply.content, "stop": simulator.is_stop(reply)}
    if method == "score":
        from tau2.data_model.simulation import SimulationRun
        from tau2.evaluator.evaluator import EvaluationType, evaluate_simulation

        task = tasks[session_id]
        simulation = SimulationRun(
            id=session_id, task_id=task.id, start_time=request["startTime"],
            end_time=request["endTime"], duration=request["duration"],
            termination_reason=request["terminationReason"], messages=trajectories[session_id],
        )
        criteria = task.evaluation_criteria
        if criteria and "NL_ASSERTION" in criteria.reward_basis and criteria.nl_assertions:
            from tau2.evaluator import evaluator_nl_assertions as nl

            if not request.get("judgeModel"):
                raise ValueError("A judge model is required for NL assertions")
            nl.DEFAULT_LLM_NL_ASSERTIONS = f"openai/{request['judgeModel']}"
            nl.DEFAULT_LLM_NL_ASSERTIONS_ARGS = {
                "api_key": os.environ["DASHSCOPE_API_KEY"], "api_base": request["baseURL"],
                "temperature": 0, "timeout": 90, "num_retries": 0,
                "extra_body": {"enable_thinking": False},
            }
        reward = evaluate_simulation(simulation, task, EvaluationType.ALL, False, env.get_domain_name())
        # Verify that the scorer's replay exactly reproduces our live DB.
        module = importlib.import_module(f"tau2.domains.{env.get_domain_name()}.environment")
        replay = module.get_environment()
        initial = task.initial_state
        replay.set_state(
            None if initial is None else initial.initialization_data,
            None if initial is None else initial.initialization_actions,
            trajectories[session_id],
        )
        return {"reward": reward.model_dump(mode="json"),
                "messages": [m.model_dump(mode="json") for m in trajectories[session_id]],
                "liveHash": env.get_db_hash(), "replayHash": replay.get_db_hash(),
                "replayMatchesLive": replay.get_db_hash() == env.get_db_hash()}
    if method == "snapshot":
        return {"database": env.tools.db.model_dump(mode="json"), "hash": env.get_db_hash()}
    if method == "raw-call":
        # API-only baseline: official execution/error semantics, no demo approval layer.
        from tau2.data_model.message import AssistantMessage, ToolCall

        call = ToolCall(id=request["id"], name=request["name"], arguments=request["args"])
        response = env.get_response(call)
        trajectories[session_id].extend([
            AssistantMessage(role="assistant", tool_calls=[call]), response,
        ])
        return {"content": response.content, "error": response.error}
    name, args = request["name"], request["args"]
    # Enforce official argument schemas before invoking Python functions.
    args = env.tools.get_tools()[name].params.model_validate(args).model_dump()
    if method == "preview":
        sandbox = copy.deepcopy(env)
        result = sandbox.use_tool(name, **args)
        data = json.loads(sandbox.to_json_str(result))
        summary = {}
        if isinstance(data, dict):
            for key in ("exchange_price_difference", "exchange_payment_method_id",
                        "return_payment_method_id", "amount", "cabin", "flights",
                        "passengers", "total_baggages", "nonfree_baggages", "insurance"):
                if data.get(key) is not None:
                    summary[key] = data[key]
            if data.get("payment_history"):
                records = getattr(env.tools.db, "orders", {}) if "order_id" in data else getattr(env.tools.db, "reservations", {})
                entity = records.get(data.get("order_id") or data.get("reservation_id"))
                previous = len(entity.payment_history) if entity is not None else 0
                summary["proposed_payment_changes"] = data["payment_history"][previous:]
        return {"content": json.dumps(summary), "hash": env.get_db_hash()}
    if request.get("hash") is not None and request["hash"] != env.get_db_hash():
        raise ValueError("Database changed since approval preview")
    result = env.use_tool(name, **args)
    from tau2.data_model.message import AssistantMessage, ToolCall, ToolMessage

    call_id = request["id"]
    trajectories[session_id].extend([
        AssistantMessage(role="assistant", tool_calls=[ToolCall(id=call_id, name=name, arguments=args)]),
        ToolMessage(id=call_id, role="tool", content=env.to_json_str(result)),
    ])
    return {"content": env.to_json_str(result)}


for line in sys.stdin:
    request = json.loads(line)
    try:
        result = {"id": request["id"], "result": dispatch(request)}
    except Exception as error:
        message = str(error)
        key = os.environ.get("DASHSCOPE_API_KEY")
        if key:
            message = message.replace(key, "[REDACTED]")
        result = {"id": request["id"], "error": message}
    protocol.write(json.dumps(result) + "\n")
    protocol.flush()
