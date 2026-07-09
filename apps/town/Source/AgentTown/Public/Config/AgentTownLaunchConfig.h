#pragma once

#include "CoreMinimal.h"

/** CLI args and Desktop session.json fallback (§8). */
struct AGENTTOWN_API FAgentTownLaunchConfig
{
	FString ApiBase = TEXT("http://localhost:8000");
	FString AccessToken;
	FString RunId;

	static FAgentTownLaunchConfig Load();
};
