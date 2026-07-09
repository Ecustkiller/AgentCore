#pragma once

#include "CoreMinimal.h"
#include "Interfaces/IHttpRequest.h"
#include "Simulation/SimTypes.h"

DECLARE_DELEGATE_TwoParams(FOnSimCreateRunComplete, bool /*bSuccess*/, const FSimCreateRunResult& /*Result*/);
DECLARE_DELEGATE_TwoParams(FOnSimAdvanceTickComplete, bool /*bSuccess*/, const FSimAdvanceTickResult& /*Result*/);
DECLARE_DELEGATE_TwoParams(FOnSimTickFrameComplete, bool /*bSuccess*/, const FSimTickFrameResult& /*Result*/);
DECLARE_DELEGATE_TwoParams(FOnSimManifestComplete, bool /*bSuccess*/, const FSimManifestResult& /*Result*/);

/** HTTP client for /v1/simulation REST (Phase 0–1). */
class AGENTTOWN_API FSimulationRestClient
{
public:
	void Configure(const FString& InApiBase, const FString& InAccessToken);

	void CreateRun(const FString& Scenario, FOnSimCreateRunComplete OnComplete);
	void AdvanceTick(const FString& RunId, FOnSimAdvanceTickComplete OnComplete);
	void GetTickSnapshot(const FString& RunId, int32 TickNumber, FOnSimTickFrameComplete OnComplete);
	void GetManifest(const FString& RunId, FOnSimManifestComplete OnComplete);

	FString GetLastError() const { return LastError; }

private:
	FString ApiBase;
	FString AccessToken;
	FString LastError;

	FString BuildUrl(const FString& Path) const;
	void ApplyAuth(TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request) const;
	void SetError(const FString& Message);
};
