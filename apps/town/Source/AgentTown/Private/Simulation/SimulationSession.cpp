#include "Simulation/SimulationSession.h"
#include "Simulation/SimSnapshotParser.h"

FSimulationSession& FSimulationSession::Get()
{
	static FSimulationSession Instance;
	return Instance;
}

bool FSimulationSession::IsReplayActive() const
{
	return Mode == ESimulationClientMode::Replay || Playhead.IsSet();
}

void FSimulationSession::Configure(
	const FString& InApiBase,
	const FString& InAccessToken,
	const FString& InitialRunId)
{
	ApiBase = InApiBase;
	AccessToken = InAccessToken;
	while (ApiBase.EndsWith(TEXT("/")))
	{
		ApiBase.LeftChopInline(1);
	}

	RestClient.Configure(ApiBase, AccessToken);
	SseClient.Configure(ApiBase, AccessToken, InitialRunId);

	if (!SseEventHandle.IsValid())
	{
		SseEventHandle = SseClient.OnEvent.AddRaw(this, &FSimulationSession::HandleSseEvent);
	}
	if (!SseStatusHandle.IsValid())
	{
		SseStatusHandle = SseClient.OnStreamStatusChanged.AddLambda(
			[this](const FString& Status, const FString& Detail)
			{
				if (Detail.IsEmpty())
				{
					SetStatusMessage(FString::Printf(TEXT("SSE: %s"), *Status));
				}
				else
				{
					SetStatusMessage(FString::Printf(TEXT("SSE: %s — %s"), *Status, *Detail));
				}
			});
	}

	if (!InitialRunId.IsEmpty())
	{
		RunId = InitialRunId;
		SetStatusMessage(FString::Printf(TEXT("Resuming run %s"), *RunId));
	}
	else
	{
		SetStatusMessage(FString::Printf(TEXT("API: %s"), *ApiBase));
	}
}

void FSimulationSession::Reset()
{
	StopPlaybackTicker();
	DisconnectStream();

	Mode = ESimulationClientMode::Live;
	RunId.Reset();
	Scenario = TEXT("town");
	Status.Reset();
	Tick = 0;
	Hour = 0;
	bTicking = false;
	Playhead.Reset();
	bPlaying = false;
	PlaybackSpeed = 1.0f;
	SeekGeneration = 0;
	PlaybackAccumulator = 0.0f;
	Agents.Reset();
	AgentUnrealPositions.Reset();
	TickCache.Reset();
	Decisions.Reset();
	Manifest = FSimRunManifest();
	SetStatusMessage(TEXT("Session reset"));
	NotifyPlaybackChanged();
}

void FSimulationSession::SetStatusMessage(const FString& Message)
{
	StatusMessage = Message;
	OnStatusChanged.Broadcast(StatusMessage);
}

void FSimulationSession::NotifyPlaybackChanged()
{
	OnPlaybackChanged.Broadcast();
}

void FSimulationSession::CacheSnapshot(int32 TickNumber, const FSimTickSnapshot& Snapshot)
{
	TickCache.Add(TickNumber, Snapshot);
}

void FSimulationSession::ApplySnapshot(const FSimTickSnapshot& Snapshot)
{
	Tick = Snapshot.Tick;
	Hour = Snapshot.Hour;
	Agents = Snapshot.Agents;
	AgentUnrealPositions.Reset();

	for (const TPair<FString, FSimAgentState>& Pair : Agents)
	{
		AgentUnrealPositions.Add(Pair.Key, FWireCoordinateTransform::ToUnreal(Pair.Value.Position));
	}

	CacheSnapshot(Snapshot.Tick, Snapshot);

	const FString ModeLabel = IsReplayActive() ? TEXT("Replay") : TEXT("Live");
	SetStatusMessage(FString::Printf(
		TEXT("%s — Tick %d (hour %d) — %d agents"), *ModeLabel, Tick, Hour, Agents.Num()));
	OnSnapshotApplied.Broadcast();
}

void FSimulationSession::EnterReplay(int32 TargetTick)
{
	Mode = ESimulationClientMode::Replay;
	Playhead = TargetTick;
	NotifyPlaybackChanged();
}

void FSimulationSession::FetchAndApplyTick(
	int32 TickNumber,
	TFunction<void(bool)> OnComplete,
	bool bUpdatePlayhead)
{
	if (RunId.IsEmpty())
	{
		SetStatusMessage(TEXT("No run — create a run first"));
		if (OnComplete)
		{
			OnComplete(false);
		}
		return;
	}

	if (const FSimTickSnapshot* Cached = TickCache.Find(TickNumber))
	{
		if (bUpdatePlayhead && IsReplayActive())
		{
			Playhead = TickNumber;
			NotifyPlaybackChanged();
		}
		ApplySnapshot(*Cached);
		if (OnComplete)
		{
			OnComplete(true);
		}
		return;
	}

	RestClient.GetTickSnapshot(RunId, TickNumber,
		FOnSimTickFrameComplete::CreateLambda([this, TickNumber, OnComplete, bUpdatePlayhead](bool bSuccess, const FSimTickFrameResult& Frame)
		{
			if (!bSuccess)
			{
				bTicking = false;
				SetStatusMessage(FString::Printf(TEXT("Load tick failed: %s"), *RestClient.GetLastError()));
				if (OnComplete)
				{
					OnComplete(false);
				}
				return;
			}

			if (bUpdatePlayhead && IsReplayActive())
			{
				Playhead = TickNumber;
				NotifyPlaybackChanged();
			}

			ApplySnapshot(Frame.Snapshot);
			if (OnComplete)
			{
				OnComplete(true);
			}
		}));
}

void FSimulationSession::FetchManifestAsync(TFunction<void(bool)> OnComplete)
{
	if (RunId.IsEmpty())
	{
		if (OnComplete)
		{
			OnComplete(false);
		}
		return;
	}

	RestClient.GetManifest(RunId,
		FOnSimManifestComplete::CreateLambda([this, OnComplete](bool bSuccess, const FSimManifestResult& Result)
		{
			if (!bSuccess)
			{
				SetStatusMessage(FString::Printf(TEXT("Manifest failed: %s"), *RestClient.GetLastError()));
				if (OnComplete)
				{
					OnComplete(false);
				}
				return;
			}

			Manifest = Result.Manifest;
			SetStatusMessage(FString::Printf(
				TEXT("Manifest loaded — %d residents"), Manifest.Personas.Num()));
			OnSnapshotApplied.Broadcast();
			if (OnComplete)
			{
				OnComplete(true);
			}
		}));
}

void FSimulationSession::ConnectStream()
{
	if (RunId.IsEmpty())
	{
		return;
	}

	SseClient.Configure(ApiBase, AccessToken, RunId);
	SseClient.Connect();
}

void FSimulationSession::DisconnectStream()
{
	SseClient.Disconnect();
}

void FSimulationSession::BootstrapActiveRun()
{
	if (RunId.IsEmpty())
	{
		return;
	}

	FetchManifestAsync();
	ConnectStream();
}

void FSimulationSession::CreateRunAsync(TFunction<void(bool)> OnComplete)
{
	SetStatusMessage(TEXT("Creating run…"));
	RestClient.CreateRun(Scenario,
		FOnSimCreateRunComplete::CreateLambda([this, OnComplete](bool bSuccess, const FSimCreateRunResult& Result)
		{
			if (!bSuccess)
			{
				SetStatusMessage(FString::Printf(TEXT("Create run failed: %s"), *RestClient.GetLastError()));
				if (OnComplete)
				{
					OnComplete(false);
				}
				return;
			}

			RunId = Result.Id;
			Status = Result.Status;
			Tick = Result.CurrentTick;
			Hour = 0;
			Mode = ESimulationClientMode::Live;
			Playhead.Reset();
			bPlaying = false;
			Agents.Reset();
			AgentUnrealPositions.Reset();
			TickCache.Reset();
			Decisions.Reset();
			Manifest = FSimRunManifest();
			NotifyPlaybackChanged();

			SetStatusMessage(FString::Printf(TEXT("Run %s created (tick %d)"), *RunId, Tick));
			OnSnapshotApplied.Broadcast();

			BootstrapActiveRun();

			if (OnComplete)
			{
				OnComplete(true);
			}
		}));
}

void FSimulationSession::AdvanceTickAsync(TFunction<void(bool)> OnComplete)
{
	if (RunId.IsEmpty())
	{
		SetStatusMessage(TEXT("No run — create a run first"));
		if (OnComplete)
		{
			OnComplete(false);
		}
		return;
	}

	if (IsReplayActive())
	{
		GoLive();
	}

	bTicking = true;
	SetStatusMessage(TEXT("Advancing tick…"));

	RestClient.AdvanceTick(RunId,
		FOnSimAdvanceTickComplete::CreateLambda([this, OnComplete](bool bSuccess, const FSimAdvanceTickResult& /*Result*/)
		{
			if (!bSuccess)
			{
				bTicking = false;
				SetStatusMessage(FString::Printf(TEXT("Advance tick failed: %s"), *RestClient.GetLastError()));
				if (OnComplete)
				{
					OnComplete(false);
				}
				return;
			}

			SetStatusMessage(TEXT("Waiting for tick to complete…"));
			if (OnComplete)
			{
				OnComplete(true);
			}
		}));
}

void FSimulationSession::LoadTickAsync(int32 TickNumber, TFunction<void(bool)> OnComplete)
{
	EnterReplay(TickNumber);
	bTicking = true;
	SetStatusMessage(FString::Printf(TEXT("Loading tick %d…"), TickNumber));
	FetchAndApplyTick(TickNumber,
		[this, OnComplete](bool bSuccess)
		{
			bTicking = false;
			if (OnComplete)
			{
				OnComplete(bSuccess);
			}
		});
}

void FSimulationSession::FetchLiveTickAsync(int32 TickNumber, TFunction<void(bool)> OnComplete)
{
	Mode = ESimulationClientMode::Live;
	Playhead.Reset();
	NotifyPlaybackChanged();
	FetchAndApplyTick(TickNumber, OnComplete, false);
}

void FSimulationSession::GoLive()
{
	++SeekGeneration;
	Mode = ESimulationClientMode::Live;
	Playhead.Reset();
	bPlaying = false;
	StopPlaybackTicker();
	NotifyPlaybackChanged();

	if (RunId.IsEmpty())
	{
		return;
	}

	if (Tick > 0)
	{
		FetchAndApplyTick(Tick, nullptr, false);
	}
	else
	{
		SetStatusMessage(TEXT("Live — waiting for first tick"));
	}
}

void FSimulationSession::SeekTick(int32 TargetTick)
{
	if (RunId.IsEmpty())
	{
		return;
	}

	if (TargetTick >= Tick && Tick > 0)
	{
		GoLive();
		return;
	}

	++SeekGeneration;
	const int32 Gen = SeekGeneration;
	EnterReplay(TargetTick);

	if (const FSimTickSnapshot* Cached = TickCache.Find(TargetTick))
	{
		ApplySnapshot(*Cached);
		return;
	}

	FetchAndApplyTick(TargetTick,
		[this, Gen, TargetTick](bool bSuccess)
		{
			if (!bSuccess || Gen != SeekGeneration)
			{
				return;
			}
			if (Playhead.Get(Tick) != TargetTick)
			{
				return;
			}
		});
}

void FSimulationSession::StepPlaybackTick(int32 Delta)
{
	SetPlaying(false);

	const int32 Tail = Tick;
	const int32 Cur = Playhead.Get(Tail);
	const int32 Next = Cur + Delta;

	if (Next < MinPlaybackTick)
	{
		return;
	}

	if (Next >= Tail)
	{
		GoLive();
		return;
	}

	SeekTick(Next);
}

void FSimulationSession::SetPlaying(bool bInPlaying)
{
	bPlaying = bInPlaying;
	if (bPlaying)
	{
		StartPlaybackTicker();
	}
	else
	{
		StopPlaybackTicker();
	}
	NotifyPlaybackChanged();
}

void FSimulationSession::SetPlaybackSpeed(float InSpeed)
{
	PlaybackSpeed = InSpeed;
	NotifyPlaybackChanged();
}

void FSimulationSession::StartPlaybackTicker()
{
	if (PlaybackTickerHandle.IsValid())
	{
		return;
	}

	PlaybackAccumulator = 0.0f;
	PlaybackTickerHandle = FTSTicker::GetCoreTicker().AddTicker(
		FTickerDelegate::CreateRaw(this, &FSimulationSession::TickPlayback));
}

void FSimulationSession::StopPlaybackTicker()
{
	if (PlaybackTickerHandle.IsValid())
	{
		FTSTicker::GetCoreTicker().RemoveTicker(PlaybackTickerHandle);
		PlaybackTickerHandle.Reset();
	}
	PlaybackAccumulator = 0.0f;
}

bool FSimulationSession::TickPlayback(float DeltaTime)
{
	if (!bPlaying || RunId.IsEmpty())
	{
		return true;
	}

	PlaybackAccumulator += DeltaTime;
	const float Interval = BasePlaybackStepSec / FMath::Max(PlaybackSpeed, 0.1f);
	if (PlaybackAccumulator < Interval)
	{
		return true;
	}

	PlaybackAccumulator = 0.0f;

	const int32 Tail = Tick;
	const int32 Cur = Playhead.Get(Tail);
	const int32 Next = Cur + 1;

	if (Next > Tail)
	{
		SetPlaying(false);
		GoLive();
		return true;
	}

	SeekTick(Next);
	return true;
}

void FSimulationSession::PushDecision(const FSimDecision& Decision)
{
	Decisions.Insert(Decision, 0);
	if (Decisions.Num() > MaxDecisions)
	{
		Decisions.SetNum(MaxDecisions);
	}
	OnDecisionsChanged.Broadcast();
}

void FSimulationSession::HandleAgentAction(const TSharedPtr<FJsonObject>& Payload)
{
	if (!Payload.IsValid())
	{
		return;
	}

	int32 EventTick = 0;
	Payload->TryGetNumberField(TEXT("tick"), EventTick);

	const TSharedPtr<FJsonObject>* ActionObj = nullptr;
	if (!Payload->TryGetObjectField(TEXT("action"), ActionObj) || !ActionObj->IsValid())
	{
		return;
	}

	FString AgentId;
	FString Thought;
	FString Detail;
	FString ActionType;
	(*ActionObj)->TryGetStringField(TEXT("agent_id"), AgentId);
	(*ActionObj)->TryGetStringField(TEXT("thought"), Thought);
	(*ActionObj)->TryGetStringField(TEXT("detail"), Detail);
	(*ActionObj)->TryGetStringField(TEXT("action"), ActionType);

	FString Summary = Thought.TrimStartAndEnd();
	if (Summary.IsEmpty())
	{
		Summary = Detail.TrimStartAndEnd();
	}
	if (Summary.IsEmpty())
	{
		Summary = ActionType;
	}

	FSimDecision Decision;
	Decision.Tick = EventTick;
	Decision.AgentId = AgentId;
	Decision.Summary = Summary;
	Decision.ActionType = ActionType;
	PushDecision(Decision);
}

void FSimulationSession::HandleAgentState(const TSharedPtr<FJsonObject>& Payload)
{
	if (!Payload.IsValid())
	{
		return;
	}

	const TSharedPtr<FJsonObject>* StateObj = nullptr;
	if (!Payload->TryGetObjectField(TEXT("state"), StateObj) || !StateObj->IsValid())
	{
		return;
	}

	FSimAgentState Agent;
	if (!FSimSnapshotParser::ParseAgentState(*StateObj, Agent))
	{
		return;
	}

	Agents.Add(Agent.AgentId, Agent);
	AgentUnrealPositions.Add(Agent.AgentId, FWireCoordinateTransform::ToUnreal(Agent.Position));
	OnSnapshotApplied.Broadcast();
}

void FSimulationSession::HandleTickEnded(int32 EndedTick, int32 EndedHour)
{
	bTicking = false;
	Tick = FMath::Max(Tick, EndedTick);
	Hour = EndedHour;

	if (IsReplayActive())
	{
		return;
	}

	++SeekGeneration;
	const int32 Gen = SeekGeneration;

	FetchAndApplyTick(EndedTick,
		[this, Gen](bool bSuccess)
		{
			if (!bSuccess || Gen != SeekGeneration || IsReplayActive())
			{
				return;
			}
		},
		false);
}

void FSimulationSession::HandleSseEvent(const FSimSseEvent& Event)
{
	if (RunId.IsEmpty())
	{
		return;
	}

	const bool bLive = !IsReplayActive();

	if (Event.Type == TEXT("sim.tick_frame"))
	{
		return;
	}

	if (!bLive)
	{
		return;
	}

	if (Event.Type == TEXT("sim.tick_started"))
	{
		int32 StartedTick = 0;
		int32 StartedHour = 0;
		if (Event.Payload.IsValid())
		{
			Event.Payload->TryGetNumberField(TEXT("tick"), StartedTick);
			Event.Payload->TryGetNumberField(TEXT("hour"), StartedHour);
		}
		bTicking = true;
		if (StartedTick > 0)
		{
			Tick = StartedTick;
		}
		if (StartedHour > 0)
		{
			Hour = StartedHour;
		}
		SetStatusMessage(FString::Printf(TEXT("Tick %d started…"), StartedTick > 0 ? StartedTick : Tick));
		return;
	}

	if (Event.Type == TEXT("sim.tick_ended"))
	{
		int32 EndedTick = 0;
		int32 EndedHour = 0;
		if (Event.Payload.IsValid())
		{
			Event.Payload->TryGetNumberField(TEXT("tick"), EndedTick);
			Event.Payload->TryGetNumberField(TEXT("hour"), EndedHour);
		}
		HandleTickEnded(EndedTick, EndedHour);
		return;
	}

	if (Event.Type == TEXT("sim.agent_action"))
	{
		HandleAgentAction(Event.Payload);
		return;
	}

	if (Event.Type == TEXT("sim.agent_state"))
	{
		HandleAgentState(Event.Payload);
	}
}
