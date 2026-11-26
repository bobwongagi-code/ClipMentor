import type { Locator, Page } from '@playwright/test'

type Surface = Page | Locator
export async function acknowledgeOverallFeedback(surface:Surface){
  await surface.getByLabel('反馈位置').selectOption('whole')
  await surface.getByLabel('确认这条意见作用于整体').check()
}

export async function checkFinalReview(surface:Surface){
  await surface.getByLabel('看过成片',{exact:true}).check()
  await surface.getByLabel('核过马来语',{exact:true}).check()
}

export const approvedFixtureReview = {
  canApproveBlueprint:true,
  reviewGroups:[{id:'fixture-group',label:'第 1 组'}],
}
