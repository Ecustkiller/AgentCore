#pragma once

#include "CoreMinimal.h"
#include "Simulation/SimTypes.h"
#include "Widgets/SCompoundWidget.h"

DECLARE_DELEGATE(FOnTownCreateRunClicked);
DECLARE_DELEGATE(FOnTownAdvanceTickClicked);
DECLARE_DELEGATE(FOnTownReplayPrevClicked);
DECLARE_DELEGATE(FOnTownReplayNextClicked);
DECLARE_DELEGATE(FOnTownReplayPlayPauseClicked);
DECLARE_DELEGATE(FOnTownGoLiveClicked);
DECLARE_DELEGATE_OneParam(FOnTownPlaybackSpeedClicked, float /*Speed*/);

struct FTownHudResident
{
	FString AgentId;
	FString Name;
	FString Role;
};

/** C++ Slate HUD — run controls, replay, manifest roster (no .uasset). */
class AGENTTOWN_API STownHUDOverlay : public SCompoundWidget
{
public:
	SLATE_BEGIN_ARGS(STownHUDOverlay) {}
		SLATE_EVENT(FOnTownCreateRunClicked, OnCreateRunClicked)
		SLATE_EVENT(FOnTownAdvanceTickClicked, OnAdvanceTickClicked)
		SLATE_EVENT(FOnTownReplayPrevClicked, OnReplayPrevClicked)
		SLATE_EVENT(FOnTownReplayNextClicked, OnReplayNextClicked)
		SLATE_EVENT(FOnTownReplayPlayPauseClicked, OnReplayPlayPauseClicked)
		SLATE_EVENT(FOnTownGoLiveClicked, OnGoLiveClicked)
		SLATE_EVENT(FOnTownPlaybackSpeedClicked, OnPlaybackSpeedClicked)
	SLATE_END_ARGS()

	void Construct(const FArguments& InArgs);
	void SetStatusText(const FText& InText);
	void SetButtonsEnabled(bool bCreateEnabled, bool bAdvanceEnabled);
	void SetResidents(const TArray<FTownHudResident>& InResidents);
	void SetDecisions(const TArray<FSimDecision>& InDecisions);
	void SetPlaybackState(int32 DisplayTick, int32 TotalTick, bool bLive, bool bPlaying, float Speed, const FString& StreamStatus);

private:
	TSharedRef<SWidget> BuildSpeedButton(float Speed, float CurrentSpeed);

	FOnTownCreateRunClicked OnCreateRunClicked;
	FOnTownAdvanceTickClicked OnAdvanceTickClicked;
	FOnTownReplayPrevClicked OnReplayPrevClicked;
	FOnTownReplayNextClicked OnReplayNextClicked;
	FOnTownReplayPlayPauseClicked OnReplayPlayPauseClicked;
	FOnTownGoLiveClicked OnGoLiveClicked;
	FOnTownPlaybackSpeedClicked OnPlaybackSpeedClicked;

	TSharedPtr<class STextBlock> StatusTextBlock;
	TSharedPtr<class STextBlock> TickTextBlock;
	TSharedPtr<class STextBlock> StreamTextBlock;
	TSharedPtr<class SVerticalBox> ResidentsBox;
	TSharedPtr<class SVerticalBox> DecisionsBox;
	TSharedPtr<class SButton> CreateRunButton;
	TSharedPtr<class SButton> AdvanceTickButton;
	TSharedPtr<class SButton> PlayPauseButton;
	TSharedPtr<class STextBlock> PlayPauseText;
};
