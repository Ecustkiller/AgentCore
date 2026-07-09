#include "Town/TownPlayerController.h"
#include "Simulation/SimulationSession.h"
#include "Town/TownHUD.h"
#include "Engine/GameViewportClient.h"
#include "Widgets/SWeakWidget.h"

void ATownPlayerController::BeginPlay()
{
	Super::BeginPlay();

	bShowMouseCursor = true;
	bEnableClickEvents = true;
	bEnableMouseOverEvents = true;
	SetInputMode(FInputModeGameAndUI());

	CreateHudOverlay();

	FSimulationSession& Session = FSimulationSession::Get();
	StatusHandle = Session.OnStatusChanged.AddUObject(this, &ATownPlayerController::HandleStatusChanged);
	SnapshotHandle = Session.OnSnapshotApplied.AddUObject(this, &ATownPlayerController::HandleSnapshotApplied);
	PlaybackHandle = Session.OnPlaybackChanged.AddUObject(this, &ATownPlayerController::HandlePlaybackChanged);
	DecisionsHandle = Session.OnDecisionsChanged.AddUObject(this, &ATownPlayerController::HandleDecisionsChanged);
	RefreshHud();
}

void ATownPlayerController::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
	if (GEngine && GEngine->GameViewport && ViewportHudHost.IsValid())
	{
		GEngine->GameViewport->RemoveViewportWidgetContent(ViewportHudHost.ToSharedRef());
	}

	FSimulationSession& Session = FSimulationSession::Get();
	Session.OnStatusChanged.Remove(StatusHandle);
	Session.OnSnapshotApplied.Remove(SnapshotHandle);
	Session.OnPlaybackChanged.Remove(PlaybackHandle);
	Session.OnDecisionsChanged.Remove(DecisionsHandle);

	HudWidget.Reset();
	ViewportHudHost.Reset();
	Super::EndPlay(EndPlayReason);
}

void ATownPlayerController::CreateHudOverlay()
{
	if (!GEngine || !GEngine->GameViewport)
	{
		return;
	}

	SAssignNew(HudWidget, STownHUDOverlay)
		.OnCreateRunClicked(FOnTownCreateRunClicked::CreateUObject(this, &ATownPlayerController::HandleCreateRun))
		.OnAdvanceTickClicked(FOnTownAdvanceTickClicked::CreateUObject(this, &ATownPlayerController::HandleAdvanceTick))
		.OnReplayPrevClicked(FOnTownReplayPrevClicked::CreateUObject(this, &ATownPlayerController::HandleReplayPrev))
		.OnReplayNextClicked(FOnTownReplayNextClicked::CreateUObject(this, &ATownPlayerController::HandleReplayNext))
		.OnReplayPlayPauseClicked(FOnTownReplayPlayPauseClicked::CreateUObject(this, &ATownPlayerController::HandleReplayPlayPause))
		.OnGoLiveClicked(FOnTownGoLiveClicked::CreateUObject(this, &ATownPlayerController::HandleGoLive))
		.OnPlaybackSpeedClicked(FOnTownPlaybackSpeedClicked::CreateUObject(this, &ATownPlayerController::HandlePlaybackSpeed));

	SAssignNew(ViewportHudHost, SWeakWidget).PossiblyNullContent(HudWidget.ToSharedRef());
	GEngine->GameViewport->AddViewportWidgetContent(ViewportHudHost.ToSharedRef(), 0);
}

void ATownPlayerController::RefreshHud()
{
	if (!HudWidget.IsValid())
	{
		return;
	}

	const FSimulationSession& Session = FSimulationSession::Get();
	HudWidget->SetStatusText(FText::FromString(Session.GetStatusMessage()));

	const bool bHasRun = !Session.GetRunId().IsEmpty();
	const bool bBusy = Session.IsTicking();
	HudWidget->SetButtonsEnabled(!bBusy, bHasRun && !bBusy);

	TArray<FTownHudResident> Residents;
	for (const FSimPersona& Persona : Session.GetManifest().Personas)
	{
		FTownHudResident Entry;
		Entry.AgentId = Persona.AgentId;
		Entry.Name = Persona.Name;
		Entry.Role = Persona.Role;
		Residents.Add(Entry);
	}
	HudWidget->SetResidents(Residents);
	HudWidget->SetDecisions(Session.GetDecisions());

	HudWidget->SetPlaybackState(
		Session.GetDisplayTick(),
		Session.GetTick(),
		Session.IsLive(),
		Session.IsPlaying(),
		Session.GetPlaybackSpeed(),
		Session.GetStreamStatus());
}

void ATownPlayerController::HandleCreateRun()
{
	FSimulationSession::Get().CreateRunAsync([this](bool /*bSuccess*/)
	{
		RefreshHud();
	});
	RefreshHud();
}

void ATownPlayerController::HandleAdvanceTick()
{
	FSimulationSession::Get().AdvanceTickAsync([this](bool /*bSuccess*/)
	{
		RefreshHud();
	});
	RefreshHud();
}

void ATownPlayerController::HandleReplayPrev()
{
	FSimulationSession::Get().StepPlaybackTick(-1);
	RefreshHud();
}

void ATownPlayerController::HandleReplayNext()
{
	FSimulationSession::Get().StepPlaybackTick(1);
	RefreshHud();
}

void ATownPlayerController::HandleReplayPlayPause()
{
	FSimulationSession& Session = FSimulationSession::Get();
	if (!Session.IsPlaying())
	{
		if (Session.IsLive() && Session.GetTick() >= 1)
		{
			Session.LoadTickAsync(1, [this](bool bSuccess)
			{
				if (bSuccess)
				{
					FSimulationSession::Get().SetPlaying(true);
				}
				RefreshHud();
			});
			RefreshHud();
			return;
		}
		Session.SetPlaying(true);
	}
	else
	{
		Session.SetPlaying(false);
	}
	RefreshHud();
}

void ATownPlayerController::HandleGoLive()
{
	FSimulationSession::Get().GoLive();
	RefreshHud();
}

void ATownPlayerController::HandlePlaybackSpeed(float Speed)
{
	FSimulationSession::Get().SetPlaybackSpeed(Speed);
	RefreshHud();
}

void ATownPlayerController::HandleStatusChanged(const FString& StatusMessage)
{
	if (HudWidget.IsValid())
	{
		HudWidget->SetStatusText(FText::FromString(StatusMessage));
	}
	RefreshHud();
}

void ATownPlayerController::HandleSnapshotApplied()
{
	RefreshHud();
}

void ATownPlayerController::HandlePlaybackChanged()
{
	RefreshHud();
}

void ATownPlayerController::HandleDecisionsChanged()
{
	RefreshHud();
}
