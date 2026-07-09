#include "Town/TownHUD.h"
#include "Simulation/SimTypes.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Layout/SScrollBox.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Text/STextBlock.h"

void STownHUDOverlay::Construct(const FArguments& InArgs)
{
	OnCreateRunClicked = InArgs._OnCreateRunClicked;
	OnAdvanceTickClicked = InArgs._OnAdvanceTickClicked;
	OnReplayPrevClicked = InArgs._OnReplayPrevClicked;
	OnReplayNextClicked = InArgs._OnReplayNextClicked;
	OnReplayPlayPauseClicked = InArgs._OnReplayPlayPauseClicked;
	OnGoLiveClicked = InArgs._OnGoLiveClicked;
	OnPlaybackSpeedClicked = InArgs._OnPlaybackSpeedClicked;

	ChildSlot
	[
		SNew(SOverlay)
		+ SOverlay::Slot()
		.HAlign(HAlign_Left)
		.VAlign(VAlign_Top)
		.Padding(24.0f)
		[
			SNew(SHorizontalBox)
			+ SHorizontalBox::Slot()
			.AutoWidth()
			.Padding(0.0f, 0.0f, 12.0f, 0.0f)
			[
				SNew(SBorder)
				.BorderImage(FCoreStyle::Get().GetBrush("ToolPanel.GroupBorder"))
				.Padding(12.0f)
				[
					SNew(SVerticalBox)
					+ SVerticalBox::Slot()
					.AutoHeight()
					.Padding(0.0f, 0.0f, 0.0f, 8.0f)
					[
						SAssignNew(StatusTextBlock, STextBlock)
						.Text(FText::FromString(TEXT("AgentTown — ready")))
						.AutoWrapText(true)
					]
					+ SVerticalBox::Slot()
					.AutoHeight()
					.Padding(0.0f, 0.0f, 0.0f, 4.0f)
					[
						SAssignNew(TickTextBlock, STextBlock)
						.Text(FText::FromString(TEXT("Tick — / —")))
					]
					+ SVerticalBox::Slot()
					.AutoHeight()
					.Padding(0.0f, 0.0f, 0.0f, 8.0f)
					[
						SAssignNew(StreamTextBlock, STextBlock)
						.Text(FText::FromString(TEXT("SSE: idle")))
						.ColorAndOpacity(FSlateColor(FLinearColor(0.6f, 0.6f, 0.6f)))
					]
					+ SVerticalBox::Slot()
					.AutoHeight()
					.Padding(0.0f, 4.0f)
					[
						SAssignNew(CreateRunButton, SButton)
						.Text(FText::FromString(TEXT("Create Run")))
						.OnClicked_Lambda([this]()
						{
							OnCreateRunClicked.ExecuteIfBound();
							return FReply::Handled();
						})
					]
					+ SVerticalBox::Slot()
					.AutoHeight()
					.Padding(0.0f, 4.0f)
					[
						SAssignNew(AdvanceTickButton, SButton)
						.Text(FText::FromString(TEXT("Advance Tick")))
						.OnClicked_Lambda([this]()
						{
							OnAdvanceTickClicked.ExecuteIfBound();
							return FReply::Handled();
						})
					]
					+ SVerticalBox::Slot()
					.AutoHeight()
					.Padding(0.0f, 8.0f, 0.0f, 4.0f)
					[
						SNew(STextBlock)
						.Text(FText::FromString(TEXT("Replay")))
						.Font(FCoreStyle::GetDefaultFontStyle("Bold", 10))
					]
					+ SVerticalBox::Slot()
					.AutoHeight()
					.Padding(0.0f, 2.0f)
					[
						SNew(SHorizontalBox)
						+ SHorizontalBox::Slot()
						.AutoWidth()
						.Padding(0.0f, 0.0f, 4.0f, 0.0f)
						[
							SNew(SButton)
							.Text(FText::FromString(TEXT("◀")))
							.OnClicked_Lambda([this]()
							{
								OnReplayPrevClicked.ExecuteIfBound();
								return FReply::Handled();
							})
						]
						+ SHorizontalBox::Slot()
						.AutoWidth()
						.Padding(0.0f, 0.0f, 4.0f, 0.0f)
						[
							SAssignNew(PlayPauseButton, SButton)
							.OnClicked_Lambda([this]()
							{
								OnReplayPlayPauseClicked.ExecuteIfBound();
								return FReply::Handled();
							})
							[
								SAssignNew(PlayPauseText, STextBlock)
								.Text(FText::FromString(TEXT("▶")))
							]
						]
						+ SHorizontalBox::Slot()
						.AutoWidth()
						.Padding(0.0f, 0.0f, 4.0f, 0.0f)
						[
							SNew(SButton)
							.Text(FText::FromString(TEXT("▶▶")))
							.OnClicked_Lambda([this]()
							{
								OnReplayNextClicked.ExecuteIfBound();
								return FReply::Handled();
							})
						]
						+ SHorizontalBox::Slot()
						.AutoWidth()
						[
							SNew(SButton)
							.Text(FText::FromString(TEXT("Live")))
							.OnClicked_Lambda([this]()
							{
								OnGoLiveClicked.ExecuteIfBound();
								return FReply::Handled();
							})
						]
					]
					+ SVerticalBox::Slot()
					.AutoHeight()
					.Padding(0.0f, 4.0f)
					[
						SNew(SHorizontalBox)
						+ SHorizontalBox::Slot().AutoWidth().Padding(0.0f, 0.0f, 4.0f, 0.0f)
						[ BuildSpeedButton(0.5f, 1.0f) ]
						+ SHorizontalBox::Slot().AutoWidth().Padding(0.0f, 0.0f, 4.0f, 0.0f)
						[ BuildSpeedButton(1.0f, 1.0f) ]
						+ SHorizontalBox::Slot().AutoWidth().Padding(0.0f, 0.0f, 4.0f, 0.0f)
						[ BuildSpeedButton(2.0f, 1.0f) ]
						+ SHorizontalBox::Slot().AutoWidth()
						[ BuildSpeedButton(4.0f, 1.0f) ]
					]
				]
			]
			+ SHorizontalBox::Slot()
			.AutoWidth()
			.Padding(0.0f, 0.0f, 12.0f, 0.0f)
			[
				SNew(SBorder)
				.BorderImage(FCoreStyle::Get().GetBrush("ToolPanel.GroupBorder"))
				.Padding(12.0f)
				[
					SNew(SBox)
					.WidthOverride(220.0f)
					.HeightOverride(320.0f)
					[
						SNew(SVerticalBox)
						+ SVerticalBox::Slot()
						.AutoHeight()
						.Padding(0.0f, 0.0f, 0.0f, 8.0f)
						[
							SNew(STextBlock)
							.Text(FText::FromString(TEXT("Residents")))
							.Font(FCoreStyle::GetDefaultFontStyle("Bold", 11))
						]
						+ SVerticalBox::Slot()
						.FillHeight(1.0f)
						[
							SNew(SScrollBox)
							+ SScrollBox::Slot()
							[
								SAssignNew(ResidentsBox, SVerticalBox)
							]
						]
					]
				]
			]
			+ SHorizontalBox::Slot()
			.AutoWidth()
			[
				SNew(SBorder)
				.BorderImage(FCoreStyle::Get().GetBrush("ToolPanel.GroupBorder"))
				.Padding(12.0f)
				[
					SNew(SBox)
					.WidthOverride(280.0f)
					.HeightOverride(320.0f)
					[
						SNew(SVerticalBox)
						+ SVerticalBox::Slot()
						.AutoHeight()
						.Padding(0.0f, 0.0f, 0.0f, 8.0f)
						[
							SNew(STextBlock)
							.Text(FText::FromString(TEXT("Decisions")))
							.Font(FCoreStyle::GetDefaultFontStyle("Bold", 11))
						]
						+ SVerticalBox::Slot()
						.FillHeight(1.0f)
						[
							SNew(SScrollBox)
							+ SScrollBox::Slot()
							[
								SAssignNew(DecisionsBox, SVerticalBox)
							]
						]
					]
				]
			]
		]
	];
}

TSharedRef<SWidget> STownHUDOverlay::BuildSpeedButton(float Speed, float CurrentSpeed)
{
	const bool bActive = FMath::IsNearlyEqual(Speed, CurrentSpeed);
	return SNew(SButton)
		.Text(FText::FromString(FString::Printf(TEXT("%.1fx"), Speed)))
		.OnClicked_Lambda([this, Speed]()
		{
			OnPlaybackSpeedClicked.ExecuteIfBound(Speed);
			return FReply::Handled();
		})
		.ButtonColorAndOpacity(bActive ? FLinearColor(0.15f, 0.35f, 0.65f, 1.0f) : FLinearColor::White);
}

void STownHUDOverlay::SetStatusText(const FText& InText)
{
	if (StatusTextBlock.IsValid())
	{
		StatusTextBlock->SetText(InText);
	}
}

void STownHUDOverlay::SetButtonsEnabled(bool bCreateEnabled, bool bAdvanceEnabled)
{
	if (CreateRunButton.IsValid())
	{
		CreateRunButton->SetEnabled(bCreateEnabled);
	}
	if (AdvanceTickButton.IsValid())
	{
		AdvanceTickButton->SetEnabled(bAdvanceEnabled);
	}
}

void STownHUDOverlay::SetResidents(const TArray<FTownHudResident>& InResidents)
{
	if (!ResidentsBox.IsValid())
	{
		return;
	}

	ResidentsBox->ClearChildren();

	if (InResidents.Num() == 0)
	{
		ResidentsBox->AddSlot()
		.AutoHeight()
		[
			SNew(STextBlock)
			.Text(FText::FromString(TEXT("No manifest yet")))
			.ColorAndOpacity(FSlateColor(FLinearColor(0.55f, 0.55f, 0.55f)))
		];
		return;
	}

	for (const FTownHudResident& Resident : InResidents)
	{
		ResidentsBox->AddSlot()
		.AutoHeight()
		.Padding(0.0f, 2.0f)
		[
			SNew(STextBlock)
			.Text(FText::FromString(FString::Printf(TEXT("%s — %s"), *Resident.Name, *Resident.Role)))
			.AutoWrapText(true)
		];
	}
}

void STownHUDOverlay::SetDecisions(const TArray<FSimDecision>& InDecisions)
{
	if (!DecisionsBox.IsValid())
	{
		return;
	}

	DecisionsBox->ClearChildren();

	if (InDecisions.Num() == 0)
	{
		DecisionsBox->AddSlot()
		.AutoHeight()
		[
			SNew(STextBlock)
			.Text(FText::FromString(TEXT("Advance a tick to see decisions")))
			.ColorAndOpacity(FSlateColor(FLinearColor(0.55f, 0.55f, 0.55f)))
			.AutoWrapText(true)
		];
		return;
	}

	const int32 MaxVisible = 12;
	for (int32 Index = 0; Index < FMath::Min(InDecisions.Num(), MaxVisible); ++Index)
	{
		const FSimDecision& Decision = InDecisions[Index];
		const FString Line = FString::Printf(
			TEXT("T%d · %s — %s"),
			Decision.Tick,
			*Decision.AgentId,
			*Decision.Summary);

		DecisionsBox->AddSlot()
		.AutoHeight()
		.Padding(0.0f, 2.0f)
		[
			SNew(STextBlock)
			.Text(FText::FromString(Line))
			.AutoWrapText(true)
		];
	}
}

void STownHUDOverlay::SetPlaybackState(
	int32 DisplayTick,
	int32 TotalTick,
	bool bLive,
	bool bPlaying,
	float Speed,
	const FString& StreamStatus)
{
	if (TickTextBlock.IsValid())
	{
		const FString ModeLabel = bLive ? TEXT("Live") : TEXT("Replay");
		const FString PlayLabel = bPlaying ? TEXT(" ▶") : TEXT("");
		TickTextBlock->SetText(FText::FromString(FString::Printf(
			TEXT("Tick %d / %d (%s%s) · %.1fx"),
			DisplayTick, TotalTick, *ModeLabel, *PlayLabel, Speed)));
	}

	if (StreamTextBlock.IsValid())
	{
		StreamTextBlock->SetText(FText::FromString(FString::Printf(TEXT("SSE: %s"), *StreamStatus)));
	}

	if (PlayPauseText.IsValid())
	{
		PlayPauseText->SetText(FText::FromString(bPlaying ? TEXT("⏸") : TEXT("▶")));
	}
}
