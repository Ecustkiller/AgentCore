#pragma once

#include "CoreMinimal.h"
#include "Containers/Ticker.h"
#include "Simulation/SimTypes.h"
#include "Simulation/SimulationRestClient.h"
#include "Simulation/SimulationSseClient.h"
#include "Simulation/WireCoordinateTransform.h"

DECLARE_MULTICAST_DELEGATE(FOnSimulationSnapshotApplied);
DECLARE_MULTICAST_DELEGATE_OneParam(FOnSimulationStatusChanged, const FString& /*StatusMessage*/);
DECLARE_MULTICAST_DELEGATE(FOnSimulationPlaybackChanged);
DECLARE_MULTICAST_DELEGATE(FOnSimulationDecisionsChanged);

/** Client-side session state — single source of truth for UI + 3D (UE-01). */
class AGENTTOWN_API FSimulationSession
{
public:
	enum class ESimulationClientMode : uint8
	{
		Live,
		Replay,
	};

	static FSimulationSession& Get();

	void Configure(const FString& ApiBase, const FString& AccessToken, const FString& InitialRunId = FString());
	void Reset();

	void ApplySnapshot(const FSimTickSnapshot& Snapshot);

	void CreateRunAsync(TFunction<void(bool)> OnComplete = nullptr);
	void AdvanceTickAsync(TFunction<void(bool)> OnComplete = nullptr);
	void LoadTickAsync(int32 TickNumber, TFunction<void(bool)> OnComplete = nullptr);
	void FetchLiveTickAsync(int32 TickNumber, TFunction<void(bool)> OnComplete = nullptr);

	void GoLive();
	void SeekTick(int32 TargetTick);
	void StepPlaybackTick(int32 Delta);
	void SetPlaying(bool bInPlaying);
	void SetPlaybackSpeed(float InSpeed);

	void BootstrapActiveRun();

	const FString& GetRunId() const { return RunId; }
	int32 GetTick() const { return Tick; }
	int32 GetHour() const { return Hour; }
	const FString& GetStatus() const { return Status; }
	const FString& GetStatusMessage() const { return StatusMessage; }
	bool IsTicking() const { return bTicking; }
	bool IsLive() const { return Mode == ESimulationClientMode::Live && !Playhead.IsSet(); }
	bool IsReplayActive() const;
	TOptional<int32> GetPlayhead() const { return Playhead; }
	int32 GetDisplayTick() const { return Playhead.Get(Tick); }
	bool IsPlaying() const { return bPlaying; }
	float GetPlaybackSpeed() const { return PlaybackSpeed; }
	FString GetStreamStatus() const { return SseClient.GetStreamStatus(); }

	const TMap<FString, FSimAgentState>& GetAgents() const { return Agents; }
	const TMap<FString, FVector>& GetAgentUnrealPositions() const { return AgentUnrealPositions; }
	const FSimRunManifest& GetManifest() const { return Manifest; }
	const TArray<FSimDecision>& GetDecisions() const { return Decisions; }

	FOnSimulationSnapshotApplied OnSnapshotApplied;
	FOnSimulationStatusChanged OnStatusChanged;
	FOnSimulationPlaybackChanged OnPlaybackChanged;
	FOnSimulationDecisionsChanged OnDecisionsChanged;

private:
	void SetStatusMessage(const FString& Message);
	void FetchAndApplyTick(int32 TickNumber, TFunction<void(bool)> OnComplete, bool bUpdatePlayhead = true);
	void FetchManifestAsync(TFunction<void(bool)> OnComplete = nullptr);
	void ConnectStream();
	void DisconnectStream();
	void HandleSseEvent(const FSimSseEvent& Event);
	void HandleTickEnded(int32 EndedTick, int32 EndedHour);
	void HandleAgentAction(const TSharedPtr<FJsonObject>& Payload);
	void HandleAgentState(const TSharedPtr<FJsonObject>& Payload);
	void PushDecision(const FSimDecision& Decision);
	void EnterReplay(int32 TargetTick);
	void NotifyPlaybackChanged();
	void StartPlaybackTicker();
	void StopPlaybackTicker();
	bool TickPlayback(float DeltaTime);
	void CacheSnapshot(int32 TickNumber, const FSimTickSnapshot& Snapshot);

	static constexpr int32 MaxDecisions = 50;
	static constexpr float BasePlaybackStepSec = 0.6f;
	static constexpr int32 MinPlaybackTick = 1;

	ESimulationClientMode Mode = ESimulationClientMode::Live;
	FString RunId;
	FString Scenario = TEXT("town");
	FString Status;
	FString StatusMessage;
	int32 Tick = 0;
	int32 Hour = 0;
	bool bTicking = false;
	TOptional<int32> Playhead;
	bool bPlaying = false;
	float PlaybackSpeed = 1.0f;
	int32 SeekGeneration = 0;
	float PlaybackAccumulator = 0.0f;

	TMap<FString, FSimAgentState> Agents;
	TMap<FString, FVector> AgentUnrealPositions;
	TMap<int32, FSimTickSnapshot> TickCache;
	TArray<FSimDecision> Decisions;
	FSimRunManifest Manifest;

	FString ApiBase;
	FString AccessToken;

	FSimulationRestClient RestClient;
	FSimulationSseClient SseClient;
	FDelegateHandle SseEventHandle;
	FDelegateHandle SseStatusHandle;
	FTSTicker::FDelegateHandle PlaybackTickerHandle;
};
