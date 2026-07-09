#pragma once

#include "CoreMinimal.h"
#include "GameFramework/PlayerController.h"
#include "TownPlayerController.generated.h"

class STownHUDOverlay;

UCLASS()
class AGENTTOWN_API ATownPlayerController : public APlayerController
{
	GENERATED_BODY()

public:
	virtual void BeginPlay() override;
	virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;

private:
	void CreateHudOverlay();
	void RefreshHud();
	void HandleCreateRun();
	void HandleAdvanceTick();
	void HandleReplayPrev();
	void HandleReplayNext();
	void HandleReplayPlayPause();
	void HandleGoLive();
	void HandlePlaybackSpeed(float Speed);
	void HandleStatusChanged(const FString& StatusMessage);
	void HandleSnapshotApplied();
	void HandlePlaybackChanged();
	void HandleDecisionsChanged();

	TSharedPtr<STownHUDOverlay> HudWidget;
	TSharedPtr<class SWidget> ViewportHudHost;
	FDelegateHandle StatusHandle;
	FDelegateHandle SnapshotHandle;
	FDelegateHandle PlaybackHandle;
	FDelegateHandle DecisionsHandle;
};
